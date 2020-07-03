const {pick} = require('lodash');
const marked = require('marked');
const TerminalRenderer = require('marked-terminal');
const envCi = require('env-ci');
const hookStd = require('hook-std');
const semver = require('semver');
const AggregateError = require('aggregate-error');
const pkg = require('./package.json');
const hideSensitive = require('./lib/hide-sensitive');
const getConfig = require('./lib/get-config');
const verify = require('./lib/verify');
const getNextVersion = require('./lib/get-next-version');
const getCommits = require('./lib/get-commits');
const getLastRelease = require('./lib/get-last-release');
const getReleaseToAdd = require('./lib/get-release-to-add');
const {extractErrors, makeTag} = require('./lib/utils');
const getGitAuthUrl = require('./lib/get-git-auth-url');
const getBranches = require('./lib/branches');
const getLogger = require('./lib/get-logger');
const {verifyAuth, isBranchUpToDate, getGitHead, tag, push, pushNotes, getTagHead, addNote} = require('./lib/git');
const getError = require('./lib/get-error');
const {COMMIT_NAME, COMMIT_EMAIL} = require('./lib/definitions/constants');
const glob = require('glob');
const path = require('path');
const mem = require('mem');
const debug = require('debug')('semantic-release:index');
const fs = require('fs');

marked.setOptions({renderer: new TerminalRenderer()});

// Simply cache remote call by repositoryUrl
const verifyPush = mem(async (repositoryUrl, context) => {
  const {cwd, env, logger} = context;

  try {
    try {
      await verifyAuth(repositoryUrl, context.branch.name, {cwd, env});
    } catch (error) {
      if (!(await isBranchUpToDate(repositoryUrl, context.branch.name, {cwd, env}))) {
        logger.log(
          `The local branch ${context.branch.name} is behind the remote one, therefore a new version won't be published.`
        );
        return false;
      }

      throw error;
    }
  } catch (error) {
    logger.error(`The command "${error.command}" failed with the error message ${error.stderr}.`);
    throw getError('EGITNOPERMISSION', context);
  }
});

const steps = {
  verifyConditions: {
    process: async (context, plugins) => {
      const {options, logger} = context;
      const {branch: ciBranch} = context.envCi;

      context.branches = await getBranches(options.repositoryUrl, ciBranch, context);
      context.branch = context.branches.find(({name}) => name === ciBranch);

      if (!context.branch) {
        logger.log(
          `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${context.branches
            .map(({name}) => name)
            .join(', ')}, therefore a new version won’t be published.`
        );
        return false;
      }

      logger[options.dryRun ? 'warn' : 'success'](
        `Run automated release from branch ${ciBranch} on repository ${options.repositoryUrl}${
          options.dryRun ? ' in dry-run mode' : ''
        }`
      );

      debug('Start verify push');
      const result = await verifyPush(options.repositoryUrl, context);
      debug('End verify push');
      if (result === false) {
        return result;
      }

      await plugins.verifyConditions(context);
    }
  },
  releaseToAddGenerateNotes: {
    process: async (context, plugins) => {
      const {cwd, env, options, logger, pkg} = context;

      const errors = [];
      context.releases = [];
      const releaseToAdd = getReleaseToAdd(context);

      if (releaseToAdd) {
        const {lastRelease, currentRelease, nextRelease} = releaseToAdd;

        nextRelease.gitHead = await getTagHead(nextRelease.gitHead, {cwd, env});
        currentRelease.gitHead = await getTagHead(currentRelease.gitHead, {cwd, env});
        if (context.branch.mergeRange && !semver.satisfies(nextRelease.version, context.branch.mergeRange)) {
          errors.push(getError('EINVALIDMAINTENANCEMERGE', {...context, nextRelease}));
        } else {
          const commits = await getCommits({...context, lastRelease, nextRelease}, pkg.path);

          // CCC
          pkg.nextRelease = nextRelease;

          nextRelease.notes = await plugins.generateNotes({...context, commits, lastRelease, nextRelease});

          if (options.dryRun) {
            logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
          } else {
            await addNote({channels: [...currentRelease.channels, nextRelease.channel]}, nextRelease.gitHead, {
              cwd,
              env
            });

            logger.success(
              `Add ${nextRelease.channel ? `channel ${nextRelease.channel}` : 'default channel'} to tag ${
                nextRelease.gitTag
              }`
            );
          }

          // Record for next step
          context.commits = commits;
          context.releaseToAdd = releaseToAdd;
          return;
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors);
      }
    },
    preprocessAll: async (context, pkgContexts) => {
      const {cwd, env, logger, options} = context;
      const releaseToAdd = pkgContexts.find(({releaseToAdd}) => releaseToAdd);

      // Push "releaseToAdd" one time
      if (releaseToAdd && !options.dryRun) {
        await push(options.repositoryUrl, {cwd, env});
        await pushNotes(options.repositoryUrl, {cwd, env});
        logger.success('Push to', options.repositoryUrl);
      }
    },
    processAll: false,
  },
  addChannel: {
    process: async (context, plugins) => {
      if (context.releaseToAdd) {
        const {lastRelease, currentRelease, nextRelease} = context.releaseToAdd;
        const commits = context.commits;

        context.branch.tags.push({
          version: nextRelease.version,
          channel: nextRelease.channel,
          gitTag: nextRelease.gitTag,
          gitHead: nextRelease.gitHead,
        });

        const releases = await plugins.addChannel({...context, commits, lastRelease, currentRelease, nextRelease});
        context.releases.push(...releases);

        // Record for next step
        context.newReleases = releases;
      }
    }
  },
  addChannelSuccess: {
    process: async (context, plugins) => {
      if (!context.releaseToAdd) {
        return;
      }

      const commits = context.commits;
      const {lastRelease, nextRelease} = context.releaseToAdd;
      const releases = context.newReleases;
      await plugins.success({...context, lastRelease, commits, nextRelease, releases});
    },
    processAll: false,
  },
  analyzeCommits: {
    process: async (context, plugins) => {
      const {cwd, env, logger, pkg} = context;

      context.lastRelease = getLastRelease(context);
      if (context.lastRelease.gitHead) {
        context.lastRelease.gitHead = await getTagHead(context.lastRelease.gitHead, {cwd, env});
      }

      if (context.lastRelease.gitTag) {
        logger.log(
          `Found git tag ${context.lastRelease.gitTag} associated with version ${context.lastRelease.version} on branch ${context.branch.name}`
        );
      } else {
        logger.log(`No git tag version found on branch ${context.branch.name}`);
      }

      // Filter commits by package path
      context.commits = await getCommits(context, pkg.path);
      context.nextReleaseType = await plugins.analyzeCommits(context);
    }
  },
  verifyRelease: {
    process: async (context, plugins) => {
      const {cwd, env, logger, options, pkg} = context;

      const nextRelease = {
        type: context.nextReleaseType,
        channel: context.branch.channel || null,
        gitHead: await getGitHead({cwd, env}),
      };

      if (!nextRelease.type) {
        logger.log('There are no relevant changes, so no new version is released.');
        return context.releases.length > 0 ? {releases: context.releases} : null;
      }

      context.nextRelease = nextRelease;
      nextRelease.version = getNextVersion(context);
      nextRelease.gitTag = makeTag(options.tagFormat, nextRelease.version);
      nextRelease.name = nextRelease.gitTag;

      if (context.branch.type !== 'prerelease' && !semver.satisfies(nextRelease.version, context.branch.range)) {
        throw getError('EINVALIDNEXTVERSION', {
          ...context,
          validBranches: context.branches.filter(
            ({type, accept}) => type !== 'prerelease' && accept.includes(nextRelease.type)
          ),
        });
      }

      // Record for later query
      pkg.nextRelease = nextRelease;

      await plugins.verifyRelease(context);
    }
  },
  generateNotes: {
    process: async (context, plugins) => {
      const {nextRelease} = context;
      if (!nextRelease) {
        return;
      }

      nextRelease.notes = await plugins.generateNotes(context);
    }
  },
  prepare: {
    process: async (context, plugins) => {
      const {nextRelease} = context;
      if (!nextRelease) {
        return;
      }

      await plugins.prepare(context);
    }
  },
  publish: {
    process: async (context, plugins) => {
      const {cwd, env, options, logger, nextRelease} = context;
      if (!nextRelease) {
        return;
      }

      if (options.dryRun) {
        logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
      } else {
        // Create the tag before calling the publish plugins as some require the tag to exists
        await tag(nextRelease.gitTag, nextRelease.gitHead, {cwd, env});
        await addNote({channels: [nextRelease.channel]}, nextRelease.gitHead, {cwd, env});
        logger.success(`Created tag ${nextRelease.gitTag}`);
      }

      const releases = await plugins.publish(context);
      context.newReleases = releases;
      context.releases.push(...releases);
    },
    preprocessAll: async (context) => {
      const {cwd, env, options, logger} = context;

      if (!options.dryRun) {
        await push(options.repositoryUrl, {cwd, env});
        await pushNotes(options.repositoryUrl, {cwd, env});
        logger.success(`Push to ${options.repositoryUrl}`);
      }
    }
  },
  success: {
    process: async (context, plugins) => {
      const {options, logger, nextRelease} = context;
      if (!nextRelease) {
        return;
      }

      await plugins.success({...context, releases: context.newReleases});

      logger.success(
        `Published release ${nextRelease.version} on ${nextRelease.channel ? nextRelease.channel : 'default'} channel`
      );

      if (options.dryRun) {
        logger.log(`Release note for version ${nextRelease.version}:`);
        if (nextRelease.notes) {
          context.stdout.write(marked(nextRelease.notes));
        }
      }

      return pick(context, ['lastRelease', 'commits', 'nextRelease', 'releases']);
    }
  }
};

/* eslint complexity: off */
async function run(context, plugins) {
  const {env, options, logger} = context;
  const {isCi, branch, prBranch, isPr} = context.envCi;
  const ciBranch = isPr ? prBranch : branch;

  logger.log('Running in', options.monorepo ? 'monorepo' : 'single repository', 'mode.');

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.warn('This run was not triggered in a known CI environment, running in dry-run mode.');
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and commiter info and prevent the `git` CLI to prompt for username/password. See #703.
    Object.assign(env, {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...env,
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: 0,
    });
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return false;
  }

  // Verify config
  await verify(context);

  options.repositoryUrl = await getGitAuthUrl({...context, branch: {name: ciBranch}});

  let pkgs = await getPkgs(context, plugins);
  if (Object.keys(pkgs).length === 0) {
    throw new Error('Cannot find packages');
  }

  const pkgContexts = Object.values(pkgs).map(pkg => {
    return {
      ...context,
      // existing
      cwd: pkg.path,
      logger: logger.scope(logger.scopeName, pkg.name),
      options: {
        ...options,
        tagFormat: options.tagFormat.replace('${name}', pkg.name),
      },
      // new
      pkg,
      pkgs,
      name: pkg.name,
    }
  });

  return await runSteps(context, pkgContexts, plugins, steps);
}

async function runSteps(context, pkgContexts, plugins, steps) {
  let result;
  const results = [];

  steps:
    for (const name of Object.keys(steps)) {
      const step = steps[name];

      if (step.process) {
        for (const context of pkgContexts) {
          result = await step.process(context, plugins);
          if (result === false) {
            break steps;
          }

          // Record release results
          if (result !== null && ['verifyRelease', 'success'].includes(name)) {
            results.push(result);
          }
        }
      }

      if (step.preprocessAll) {
        await step.preprocessAll(context, pkgContexts);
      }

      if (step.processAll !== false) {
        await plugins[name + 'All']({...context, pkgContexts});
      }
    }

  return result === false ? false : results;
}

function logErrors({logger, stderr}, err) {
  const errors = extractErrors(err).sort((error) => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.error(`${error.code} ${error.message}`);
      if (error.details) {
        stderr.write(marked(error.details));
      }
    } else {
      logger.error('An error occurred while running semantic-release: %O', error);
    }
  }
}

async function callFail(context, plugins, err) {
  const errors = extractErrors(err).filter((err) => err.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({...context, errors});
    } catch (error) {
      logErrors(context, error);
    }
  }
}

async function getPkgs(context, plugins) {
  const {cwd, options, logger} = context;

  let pkgs = {};
  logger.log('Find packages in directories: %s', options.packages.join(', '));

  for (const pkg of options.packages) {
    const dirs = glob.sync(pkg, {cwd});
    for (const dir of dirs) {
      const fullPath = path.join(cwd, dir);
      const name = await getPkgName(fullPath) || path.basename(dir);
      pkgs[name] = {
        name,
        path: fullPath,
      };
    }
  }

  pkgs = await plugins.initPkgs({...context, pkgs});

  logger.success('Found %d packages: %s', Object.keys(pkgs).length, Object.keys(pkgs).join(', '));
  return pkgs;
}

async function getPkgName(dir) {
  const pkgFile = path.join(dir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    return JSON.parse(fs.readFileSync(pkgFile).toString()).name;
  }
  return null;
}

module.exports = async (cliOptions = {}, {cwd = process.cwd(), env = process.env, stdout, stderr} = {}) => {
  const {unhook} = hookStd(
    {silent: false, streams: [process.stdout, process.stderr, stdout, stderr].filter(Boolean)},
    hideSensitive(env)
  );
  const context = {
    cwd,
    env,
    stdout: stdout || process.stdout,
    stderr: stderr || process.stderr,
    envCi: envCi({env, cwd}),
  };
  context.logger = getLogger(context);
  context.logger.log(`Running ${pkg.name} version ${pkg.version}`);
  try {
    const {plugins, options} = await getConfig(context, cliOptions);
    context.options = options;
    try {
      const result = await run(context, plugins);
      unhook();
      return result;
    } catch (error) {
      await callFail(context, plugins, error);
      throw error;
    }
  } catch (error) {
    logErrors(context, error);
    unhook();
    throw error;
  }
};
