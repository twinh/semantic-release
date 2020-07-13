const {template, isString, isPlainObject} = require('lodash');
const AggregateError = require('aggregate-error');
const {isGitRepo, verifyTagName} = require('./git');
const getError = require('./get-error');

module.exports = async (context) => {
  const {
    cwd,
    env,
    options: {repositoryUrl, tagFormat, branches, monorepo, versionMode},
  } = context;
  const errors = [];

  if (!(await isGitRepo({cwd, env}))) {
    errors.push(getError('ENOGITREPO', {cwd}));
  } else if (!repositoryUrl) {
    errors.push(getError('ENOREPOURL'));
  }

  // Verify that compiling the `tagFormat` produce a valid Git tag
  if (!(await verifyTagName(template(tagFormat)({name: 'test', version: '0.0.0'})))) {
    errors.push(getError('EINVALIDTAGFORMAT', context));
  }

  // Verify the `tagFormat` contains the variable `version` (and `name`) by compiling the `tagFormat` template
  // with a space as the `version` (and `name`) value and verify the result contains the space.
  // The space is used as it's an invalid tag character, so it's guaranteed to no be present in the `tagFormat`.
  const hasName = monorepo && versionMode !== 'fixed';
  if ((template(tagFormat)({name: ' ', version: ' '}).match(/ /g) || []).length !== (hasName ? 2 : 1)) {
    errors.push(getError(monorepo ? 'ETAGNONAMEORVERSION' : 'ETAGNOVERSION', context));
  }

  branches.forEach((branch) => {
    if (
      !((isString(branch) && branch.trim()) || (isPlainObject(branch) && isString(branch.name) && branch.name.trim()))
    ) {
      errors.push(getError('EINVALIDBRANCH', {branch}));
    }
  });

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }
};
