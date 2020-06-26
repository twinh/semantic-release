const {pick, forEach, keyBy, last} = require('lodash');
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

marked.setOptions({renderer: new TerminalRenderer()});

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

  const packages = await getPackages(options, context);
  if (Object.keys(packages).length === 0) {
    throw new Error('Cannot find packages');
  }

  for (const pkg of Object.values(packages)) {
    const pkgContext = Object.assign({}, context);

    let pkgOptions = options;
    pkgOptions.path = pkg.path;
    pkgOptions.tagFormat = pkg.json.name + '@${version}';

    pkg.context = pkgContext;
    pkg.options = pkgOptions;

    await runPackage(pkgContext, plugins, pkgOptions, pkg, packages);
  }

  for (const pkg of Object.values(packages)) {
    await commitPackage(pkg.context, plugins, pkg.options);
  }

  // TODO push when have new release
  // Only Push one time
  if (!options.dryRun) {
    await push(options.repositoryUrl, {cwd, env});
    await pushNotes(options.repositoryUrl, {cwd, env});
    logger.success(`Push to ${options.repositoryUrl}`);
  }
}

async function runPackage(context, plugins, options, pkg, packages) {
  const {cwd, env, logger} = context;
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
      const commits = await getCommits({...context, lastRelease, nextRelease}, options.path);
      nextRelease.notes = await plugins.generateNotes({...context, commits, lastRelease, nextRelease});

      if (options.dryRun) {
        logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
      } else {
        await addNote({channels: [...currentRelease.channels, nextRelease.channel]}, nextRelease.gitHead, {cwd, env});
        await push(options.repositoryUrl, {cwd, env});
        await pushNotes(options.repositoryUrl, {cwd, env});
        logger.success(
          `Add ${nextRelease.channel ? `channel ${nextRelease.channel}` : 'default channel'} to tag ${
            nextRelease.gitTag
          }`
        );
      }

      context.branch.tags.push({
        version: nextRelease.version,
        channel: nextRelease.channel,
        gitTag: nextRelease.gitTag,
        gitHead: nextRelease.gitHead,
      });

      const releases = await plugins.addChannel({...context, commits, lastRelease, currentRelease, nextRelease});
      context.releases.push(...releases);
      await plugins.success({...context, lastRelease, commits, nextRelease, releases});
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

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
  context.commits = await getCommits(context, options.path);

  const nextRelease = {
    type: await plugins.analyzeCommits(context),
    channel: context.branch.channel || null,
    gitHead: await getGitHead({cwd, env}),
  };

  if (!nextRelease.type) {
    nextRelease.type = generateDependencyRelease(pkg, packages);
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

  nextRelease.notes = await plugins.generateNotes(context);

  nextRelease.notes += generateDependencyNotes(pkg, packages);
  updateVersions(pkg, packages);
  if (pkg.changed) {
    logger.log('Write package %s with data %O', pkg.path, pkg.json);
    if (!options.dryRun) {
      // TODO ignore "readme", "_id"
      await writePkg(pkg.path, pkg.json);
    }
  }

  context.nextRelease = nextRelease;
}

async function commitPackage(context, plugins, options) {
  const {cwd, env, logger, nextRelease} = context;

  await plugins.prepare(context);

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

async function getPackages(options, context) {
  let packages = {};
  for (const pkg of options.packages) {
    const paths = glob.sync(pkg, {cwd: context.cwd});
    for (const path of paths) {
      const json = (await readPkg({cwd: path})) || {};
      packages[json.name] = {
        path,
        json,
        dependencies: []
      };
    }
  }

  // TODO support composer.json dependencies
  let graph = [];
  forEach(packages, (pkg) => {
    forEach(Object.assign(
      {},
      pkg.json.dependencies || {},
      pkg.json.devDependencies || {}
    ), (version, name) => {
      graph.push([packages[name], pkg]);

      pkg.dependencies.push(name)
    });
  });

  packages = toposort(graph);
  packages = keyBy(packages, 'json.name');

  return packages;
}

function generateDependencyNotes(pkg, packages) {
  let notes = [];
  pkg.dependencies.forEach(name => {
    if (packages[name].nextRelease.version) {
      notes.push(`* **${name}:** upgraded to ${packages[name].nextRelease.version}`);
    }
  });
  if (notes.length) {
    notes.unshift('### Dependencies');
  }
  return notes.join('\n');
}

function generateDependencyRelease(pkg, packages) {
  let type;
  pkg.dependencies.forEach(name => {
    if (packages[name].nextRelease.type) {
      type = 'patch';
      return false;
    }
  });
  return type;
}

function updateVersions(pkg, packages) {
  pkg.dependencies.forEach(name => {
    if (packages[name].nextRelease.version) {
      ['devDependencies', 'dependencies'].forEach(key => {
        if (typeof pkg.json[key] !== 'undefined' && typeof pkg.json[key][name] !== 'undefined') {
          pkg.json[key][name] = '^' + packages[name].nextRelease.version;
          pkg.changed = true;
          return false;
        }
      });
    }
  });
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
