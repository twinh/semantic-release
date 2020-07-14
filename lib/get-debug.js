const debug = require('debug');

const debugs = {};

module.exports = (...names) => {
  const name = names.join(':');
  if (typeof debugs[name] === 'undefined') {
    debugs[name] = debug('semantic-release:' + name);
  }

  return debugs[name];
};
