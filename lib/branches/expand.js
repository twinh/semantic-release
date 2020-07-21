const {isString, remove, omit, mapValues, template} = require('lodash');
const micromatch = require('micromatch');
const {getBranches} = require('../git');
const mem = require('mem');

const memGetBranches = mem((...args) => getBranches(...args));

module.exports = async (repositoryUrl, {cwd}, branches) => {
  // Simply cache remote call by repositoryUrl
  // Use a copy of array, so that the memoize value wont be changed in the following "remove" call
  const gitBranches = [...(await memGetBranches(repositoryUrl, {cwd}))];

  return branches.reduce(
    (branches, branch) => [
      ...branches,
      ...remove(gitBranches, (name) => micromatch(gitBranches, branch.name).includes(name)).map((name) => ({
        name,
        ...mapValues(omit(branch, 'name'), (value) => (isString(value) ? template(value)({name}) : value)),
      })),
    ],
    []
  );
};
