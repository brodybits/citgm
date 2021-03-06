'use strict';
const EventEmitter = require('events').EventEmitter;
const util = require('util');

const async = require('async');
const npa = require('npm-package-arg');
const BufferList = require('bl');
let which = require('which'); // Mocked in tests

const grabModuleData = require('./grab-module-data');
const grabProject = require('./grab-project');
const lookup = require('./lookup');
const npm = require('./npm');
const tempDirectory = require('./temp-directory');
const unpack = require('./unpack');

const windows = (process.platform === 'win32');
exports.windows = windows;

/**
 * The process here is straightforward:
 * 1. We pull down information about the module from npm
 * 2. We create a temporary working directory and pull down the
 *    module using the git repo shown in the npm metadata or,
 *    if the repo is not specified, by pulling the code from
 *    npm itself
 * 3. If npm-test is implemented, invoke to run the tests. Otherwise,
 * 4. Filter the output of 4 through the Reporter script (details TBD)
 * 5. Output the results.
 **/

function find(app, context, next) {
  which(app, function(err, resolved) {
    if (err) {
      next(Error(app + ' not found in path!'));
      return;
    }
    context.emit('data', 'verbose', context.module.name + ' using-' + app,
        resolved);
    next(null, context);
  });
}

function init(context, next) {
  // Single module that citgm is testing.
  if (!windows) {
    if (context.options.uid)
      context.emit('data', 'verbose', context.module.name + ' using-uid',
          context.options.uid);
    if (context.options.gid)
      context.emit('data', 'verbose', context.module.name + ' using-gid',
          context.options.gid);
  }
  context.emit('data', 'silly', context.module.name + ' init-detail',
      context.module);
  next(null, context); // Inject the context
}

function sha1(mod) {
  const crypto = require('crypto');
  const shasum = crypto.createHash('sha1');
  shasum.update(mod);
  return shasum.digest('hex');
}

function extractDetail(mod) {
  const detail = npa(mod); // Will throw on failure
  detail.name = detail.name || sha1(mod);
  return detail;
}

/**
 * Setup the test
 *  - module = the name of the npm module to check out
 *
 * The Tester will emit specific events once it is run:
 *  - end = emitted when the test is complete
 *  - fail = emitted if the test fails for any reason
 *  - info = informational events (for debugging)
 *  - start = emitted when run is started
 **/

function Tester(mod, options) {
  if (!(this instanceof Tester))
    return new Tester(mod, options);
  EventEmitter.call(this);
  this.module = extractDetail(mod);
  this.options = options;
  this.testOutput = new BufferList();
  this.testError = new BufferList();
  this.cleanexit = false;
}

util.inherits(Tester, EventEmitter);

Tester.prototype.run = function() {
  this.emit('start', this.module.raw, this.options);

  async.waterfall([
    init.bind(null, this),
    find.bind(null, 'node'),
    find.bind(null, 'npm'),
    tempDirectory.create,
    grabModuleData,
    lookup,
    grabProject,
    unpack,
    npm.install,
    npm.test
  ], (err) => {
    if (!this.cleanexit) {
      const payload = {
        name: this.module.name || this.module.raw,
        version: this.module.version,
        flaky: this.module.flaky,
        expectFail: this.module.expectFail
      };
      if (err && !payload.expectFail) {
        this.emit('fail', err);
        payload.error = err;
      } else if (!err && payload.expectFail) {
        this.emit('fail', 'this module should have failed');
        payload.error = 'this module should have failed';
      }
      if (this.testOutput !== '') {
        payload.testOutput += this.testOutput.toString() + '\n';
      }
      if (this.testError !== '') {
        payload.testOutput += this.testError.toString() + '\n';
      }
      tempDirectory.remove(this, () => {
        this.emit('end', payload);
        this.cleanexit = true;
      });
    }
  });
};

Tester.prototype.cleanup = function () {
  this.cleanexit = true;
  const payload = {
    name: this.module.name || this.module.raw,
    error: Error('Process Interrupted')
  };
  this.emit('fail', payload.error);
  tempDirectory.remove(this, () => {
    this.emit('end', payload);
  });
};

exports.Tester = Tester;
