const {isString, isRegExp} = require('lodash');
const AggregateError = require('aggregate-error');
const pEachSeries = require('p-each-series');
const DEFINITIONS = require('../definitions/branches');
const getError = require('../get-error');
const {fetch, fetchNotes, verifyBranchName} = require('../git');
const expand = require('./expand');
const getTags = require('./get-tags');
const normalize = require('./normalize');
const mem = require('mem');
const debug = require('debug')('semantic-release:branches');

const memFetches = mem(async (repositoryUrl, remoteBranches, ciBranch, context) => {
  const {cwd, env} = context;

  await pEachSeries(remoteBranches, async ({name}) => {
    debug('Start fetch branch', name);
    await fetch(repositoryUrl, name, ciBranch, {cwd, env});
    debug('End fetch branch', name);
  });

  debug('Start fetch notes');
  await fetchNotes(repositoryUrl, {cwd, env});
  debug('End fetch notes');
});

module.exports = async (repositoryUrl, ciBranch, context) => {
  debug('Start get remote branches');
  const remoteBranches = await expand(
    repositoryUrl,
    context,
    context.options.branches.map((branch) => (isString(branch) || isRegExp(branch) ? {name: branch} : branch))
  );
  debug('End get remote branches: %o', remoteBranches);

  // Simply cache remote call by repositoryUrl
  await memFetches(repositoryUrl, remoteBranches, ciBranch, context);

  const branches = await getTags(context, remoteBranches);

  const errors = [];
  const branchesByType = Object.entries(DEFINITIONS).reduce(
    (branchesByType, [type, {filter}]) => ({[type]: branches.filter(filter), ...branchesByType}),
    {}
  );

  const result = Object.entries(DEFINITIONS).reduce((result, [type, {branchesValidator, branchValidator}]) => {
    branchesByType[type].forEach((branch) => {
      if (branchValidator && !branchValidator(branch)) {
        errors.push(getError(`E${type.toUpperCase()}BRANCH`, {branch}));
      }
    });

    const branchesOfType = normalize[type](branchesByType);

    if (!branchesValidator(branchesOfType)) {
      errors.push(getError(`E${type.toUpperCase()}BRANCHES`, {branches: branchesOfType}));
    }

    return {...result, [type]: branchesOfType};
  }, {});

  const duplicates = [...branches]
    .map((branch) => branch.name)
    .sort()
    .filter((_, idx, array) => array[idx] === array[idx + 1] && array[idx] !== array[idx - 1]);

  if (duplicates.length > 0) {
    errors.push(getError('EDUPLICATEBRANCHES', {duplicates}));
  }

  await pEachSeries(branches, async (branch) => {
    if (!(await verifyBranchName(branch.name))) {
      errors.push(getError('EINVALIDBRANCHNAME', branch));
    }
  });

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  return [...result.maintenance, ...result.release, ...result.prerelease];
};
