/* eslint require-atomic-updates: off */

const {isString, isPlainObject} = require('lodash');
const {getGitHead} = require('../git');
const hideSensitive = require('../hide-sensitive');
const {hideSensitiveValues} = require('../utils');
const {RELEASE_TYPE, RELEASE_NOTES_SEPARATOR} = require('./constants');
const debug = require('debug')('semantic-release:plugins');

async function updateNextRelease(context, newGitHead, generateNotes) {
  // If previous prepare plugin has created a commit (gitHead changed)
  if (context.nextRelease.gitHead !== newGitHead) {
    debug('Update git head from', context.nextRelease.gitHead, 'to', newGitHead);
    context.nextRelease.gitHead = newGitHead;
    // Regenerate the release notes
    context.nextRelease.notes = await generateNotes(context);
  }

  return context;
}

module.exports = {
  initPkgs: {
    required: false,
    dryRun: true,
    pipelineConfig: () => ({
      // Pass `pkgs` to next step
      getNextInput: (context, pkgs) => ({...context, pkgs}),
    }),
    // Return last result or default packages
    postprocess: (results, context) => results[results.length - 1] || context.pkgs,
  },
  verifyConditions: {
    required: false,
    dryRun: true,
    pipelineConfig: () => ({settleAll: true}),
  },
  verifyConditionsAll: {
    required: false,
    dryRun: true,
    pipelineConfig: () => ({settleAll: true}),
  },
  analyzeCommits: {
    default: ['@semantic-release/commit-analyzer'],
    required: true,
    dryRun: true,
    outputValidator: (output) => !output || RELEASE_TYPE.includes(output),
    preprocess: ({commits, ...inputs}) => ({
      ...inputs,
      commits: commits.filter((commit) => !/\[skip\s+release]|\[release\s+skip]/i.test(commit.message)),
    }),
    postprocess: (results) =>
      RELEASE_TYPE[
        results.reduce((highest, result) => {
          const typeIndex = RELEASE_TYPE.indexOf(result);
          return typeIndex > highest ? typeIndex : highest;
        }, -1)
      ],
  },
  analyzeCommitsAll: {
    required: false,
    dryRun: true,
    outputValidator: (output) => !output || isPlainObject(output),
    postprocess: (results) => {
      return results.filter(Boolean).reduce((releaseTypes, result) => {
        Object.entries(result).forEach(([name, releaseType]) => {
          if (RELEASE_TYPE.indexOf(releaseType) > RELEASE_TYPE.indexOf(releaseTypes[name])) {
            releaseTypes[name] = releaseType;
          }
        });
        return releaseTypes;
      }, {});
    },
  },
  verifyRelease: {
    required: false,
    dryRun: true,
    pipelineConfig: () => ({settleAll: true}),
  },
  verifyReleaseAll: {
    required: false,
    dryRun: true,
    pipelineConfig: () => ({settleAll: true}),
  },
  generateNotes: {
    required: false,
    dryRun: true,
    outputValidator: (output) => !output || isString(output),
    pipelineConfig: () => ({
      getNextInput: ({nextRelease, ...context}, notes) => ({
        ...context,
        nextRelease: {
          ...nextRelease,
          notes: `${nextRelease.notes ? `${nextRelease.notes}${RELEASE_NOTES_SEPARATOR}` : ''}${notes}`,
        },
      }),
    }),
    postprocess: (results, {env}) => hideSensitive(env)(results.filter(Boolean).join(RELEASE_NOTES_SEPARATOR)),
  },
  generateNotesAll: {
    required: false,
    dryRun: true,
  },
  prepare: {
    required: false,
    dryRun: false,
    pipelineConfig: ({generateNotes}) => ({
      getNextInput: async (context) => {
        const newGitHead = await getGitHead({cwd: context.cwd});
        context = updateNextRelease(context, newGitHead, generateNotes);

        // Call the next prepare plugin with the updated `nextRelease`
        return context;
      },
    }),
  },
  prepareAll: {
    required: false,
    dryRun: false,
    pipelineConfig: ({generateNotes}) => ({
      getNextInput: async (context) => {
        const newGitHead = await getGitHead({cwd: context.cwd});

        for (let pkgContext of Object.values(context.pkgContexts)) {
          if (!pkgContext.nextRelease) {
            continue;
          }

          pkgContext = updateNextRelease(pkgContext, newGitHead, generateNotes);
        }

        // Call the next prepare plugin with the updated `nextRelease`
        return context;
      },
    }),
  },
  publish: {
    required: false,
    dryRun: false,
    outputValidator: (output) => !output || isPlainObject(output),
    pipelineConfig: () => ({
      // Add `nextRelease` and plugin properties to published release
      transform: (release, step, {nextRelease}) => ({
        ...(release === false ? {} : nextRelease),
        ...release,
        ...step,
      }),
    }),
  },
  publishAll: {
    required: false,
    dryRun: false,
  },
  addChannel: {
    required: false,
    dryRun: false,
    outputValidator: (output) => !output || isPlainObject(output),
    pipelineConfig: () => ({
      // Add `nextRelease` and plugin properties to published release
      transform: (release, step, {nextRelease}) => ({
        ...(release === false ? {} : nextRelease),
        ...release,
        ...step,
      }),
    }),
  },
  addChannelAll: {
    required: false,
    dryRun: false,
  },
  success: {
    required: false,
    dryRun: false,
    pipelineConfig: () => ({settleAll: true}),
    preprocess: ({releases, env, ...inputs}) => ({...inputs, env, releases: hideSensitiveValues(env, releases)}),
  },
  successAll: {
    required: false,
    dryRun: false,
  },
  fail: {
    required: false,
    dryRun: false,
    pipelineConfig: () => ({settleAll: true}),
    preprocess: ({errors, env, ...inputs}) => ({...inputs, env, errors: hideSensitiveValues(env, errors)}),
  },
  // No failAll
};
