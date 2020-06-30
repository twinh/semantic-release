const {pick, forEach, keyBy, isFunction} = require('lodash');
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
const readPkg = require('read-pkg');
const toposort = require('toposort');
const writePkg = require('write-pkg');
const path = require('path');

marked.setOptions({renderer: new TerminalRenderer()});

const steps = {
  verifyConditions: {
    process: async (context, plugins) => {
      const {cwd, env, options, logger} = context;
      const {branch: ciBranch} = context.envCi;

      // TODO cache remote call
      options.repositoryUrl = await getGitAuthUrl({...context, branch: {name: ciBranch}});
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

      try {
        try {
          await verifyAuth(options.repositoryUrl, context.branch.name, {cwd, env});
        } catch (error) {
          if (!(await isBranchUpToDate(options.repositoryUrl, context.branch.name, {cwd, env}))) {
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

      logger.success(`Allowed to push to the Git repository`);

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

          nextRelease.notes = await plugins.generateNotes({...context, commits, lastRelease, nextRelease});
          pkg.nextRelease = nextRelease;

          // TODO releaseToAdd dont need updateNotesAndVersions?
          await updateNotesAndVersions(context);

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
    processAll: async (context, contexts) => {
      const {options} = context;

      // Push "releaseToAdd" one time
      for (const context of contexts) {
        if (context.releaseToAdd) {
          // await plugins.generateNotesAll();
          if (!options.dryRun) {
            await push(options.repositoryUrl, {cwd, env});
            await pushNotes(options.repositoryUrl, {cwd, env});
            break;
          }
        }
      }
    }
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
      const {cwd, env, logger, options, pkg, pkgs} = context;

      const nextRelease = {
        type: context.nextReleaseType,
        channel: context.branch.channel || null,
        gitHead: await getGitHead({cwd, env}),
      };

      if (!nextRelease.type) {
        nextRelease.type = generateDependencyRelease(pkg, pkgs);
      }

      // Record for later query
      pkg.nextRelease = nextRelease;

      if (!nextRelease.type) {
        logger.log('There are no relevant changes, so no new version is released.');
        return context.releases.length > 0 ? {releases: context.releases} : false;
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

      await plugins.verifyRelease(context);
    }
  },
  generateNotes: {
    process: async (context, plugins) => {
      const {nextRelease} = context;
      if (!nextRelease) {
        return false;
      }

      nextRelease.notes = await plugins.generateNotes(context);
      await updateNotesAndVersions(context);
    }
  },
  prepare: {
    process: async (context, plugins) => {
      const {nextRelease} = context;
      if (!nextRelease) {
        return false;
      }

      await plugins.prepare(context);
    }
  },
  publish: {
    process: async (context, plugins) => {
      const {cwd, env, options, logger, nextRelease} = context;
      if (!nextRelease) {
        return false;
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
      context.releases.push(...releases);
    },
    preprocessAll: async (context) => {
      const {options, logger} = context;

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
        return false;
      }

      await plugins.success({...context, releases});

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
  const {cwd, env, options, logger} = context;
  const {isCi, isPr} = context.envCi;

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

  const pkgs = await getPkgs(context);
  if (Object.keys(pkgs).length === 0) {
    throw new Error('Cannot find packages');
  }

  const defaultContext = context;
  let contexts = [];
  for (const pkg of Object.values(pkgs)) {
    contexts.push({
      ...context,
      // existing
      cwd: pkg.path,
      logger: logger.scope(logger.scopeName, pkg.json.name),
      options: {
        ...context.options,
        tagFormat: pkg.json.name + '@${version}'
      },
      // new
      pkg,
      pkgs,
      name: pkg.json.name,
    });
  }

  await runSteps(defaultContext, contexts, plugins, steps);
}

async function runSteps(defaultContext, contexts, plugins, steps) {
  for (const name of Object.keys(steps)) {
    const step = steps[name];

    if (step.process) {
      for (const context of contexts) {
        await step.process(context, plugins);
      }
    }

    if (step.preprocessAll) {
      await step.preprocessAll(defaultContext, contexts);
    }

    if (step.processAll === false) {
      continue;
    }
    if (step.processAll) {
      await step.processAll(defaultContext, contexts);
    } else {
      await plugins[name + 'All']({...defaultContext, pkgContexts: contexts});
    }
  }
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

async function getPkgs(context) {
  const {cwd, options} = context;

  let pkgs = {};
  for (const pkg of options.packages) {
    const dirs = glob.sync(pkg, {cwd});
    for (const dir of dirs) {
      const json = (await readPkg({cwd: dir, normalize: false})) || {};
      pkgs[json.name] = {
        path: path.join(cwd, dir),
        json,
        dependencies: []
      };
    }
  }

  // TODO support composer.json dependencies
  let graph = [];
  forEach(pkgs, (pkg) => {
    forEach(Object.assign(
      {},
      pkg.json.dependencies || {},
      pkg.json.devDependencies || {}
    ), (version, name) => {
      graph.push([pkgs[name], pkg]);

      pkg.dependencies.push(name)
    });
  });

  pkgs = toposort(graph);
  pkgs = keyBy(pkgs, 'json.name');

  return pkgs;
}

function generateDependencyNotes(pkg, pkgs) {
  let notes = [];
  pkg.dependencies.forEach(name => {
    if (pkgs[name].nextRelease && pkgs[name].nextRelease.version) {
      notes.push(`* **${name}:** upgraded to ${pkgs[name].nextRelease.version}`);
    }
  });
  if (notes.length) {
    notes.unshift('### Dependencies');
  }
  return notes.join('\n');
}

function generateDependencyRelease(pkg, pkgs) {
  let type;
  pkg.dependencies.forEach(name => {
    if (pkgs[name].nextRelease.type) {
      type = 'patch';
      return false;
    }
  });
  return type;
}

function updateVersions(pkg, pkgs) {
  // Update self version
  pkg.json.version = pkgs[pkg.json.name].nextRelease.version;

  // Update dependency versions
  pkg.dependencies.forEach(name => {
    if (pkgs[name].nextRelease && pkgs[name].nextRelease.version) {
      ['devDependencies', 'dependencies'].forEach(key => {
        if (typeof pkg.json[key] !== 'undefined' && typeof pkg.json[key][name] !== 'undefined') {
          pkg.json[key][name] = '^' + pkgs[name].nextRelease.version;
          pkg.changed = true;
          return false;
        }
      });
    }
  });
}

async function updateNotesAndVersions(context) {
  const {logger, options, pkg, pkgs} = context;

  pkg.nextRelease.notes += generateDependencyNotes(pkg, pkgs);
  updateVersions(pkg, pkgs);

  logger.log('Write package %s with data %O', pkg.path, pkg.json);
  if (!options.dryRun) {
    await writePkg(pkg.path, pkg.json, {normalize: false});
  }
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
