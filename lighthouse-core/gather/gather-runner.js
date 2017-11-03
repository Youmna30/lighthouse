/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const log = require('lighthouse-logger');
const Audit = require('../audits/audit');
const URL = require('../lib/url-shim');
const NetworkRecorder = require('../lib/network-recorder.js');

/**
 * @typedef {!Object<string, !Array<!Promise<*>>>}
 */
let GathererResults; // eslint-disable-line no-unused-vars

/**
 * Class that drives browser to load the page and runs gatherer lifecycle hooks.
 * Execution sequence when GatherRunner.run() is called:
 *
 * 1. Setup
 *   A. navigate to about:blank
 *   B. driver.connect()
 *   C. GatherRunner.setupDriver()
 *     i. assertNoSameOriginServiceWorkerClients
 *     ii. beginEmulation
 *     iii. enableRuntimeEvents
 *     iv. evaluateScriptOnLoad rescue native Promise from potential polyfill
 *     v. register a performance observer
 *     vi. register dialog dismisser
 *     vii. clearDataForOrigin
 *
 * 2. For each pass in the config:
 *   A. GatherRunner.beforePass()
 *     i. navigate to about:blank
 *     ii. Enable network request blocking for specified patterns
 *     iii. all gatherers' beforePass()
 *   B. GatherRunner.pass()
 *     i. cleanBrowserCaches() (if it's a perf run)
 *     ii. beginDevtoolsLog()
 *     iii. beginTrace (if requested)
 *     iv. GatherRunner.loadPage()
 *       a. navigate to options.url (and wait for onload)
 *     v. all gatherers' pass()
 *   C. GatherRunner.afterPass()
 *     i. endTrace (if requested) & endDevtoolsLog & endThrottling
 *     ii. all gatherers' afterPass()
 *
 * 3. Teardown
 *   A. GatherRunner.disposeDriver()
 *   B. collect all artifacts and return them
 *     i. collectArtifacts() from completed passes on each gatherer
 *     ii. add trace data and computed artifact methods
 */
class GatherRunner {
  /**
   * Loads about:blank and waits there briefly. Since a Page.reload command does
   * not let a service worker take over, we navigate away and then come back to
   * reload. We do not `waitForLoad` on about:blank since a page load event is
   * never fired on it.
   * @param {!Driver} driver
   * @param {url=} url
   * @param {number=} duration
   * @return {!Promise}
   */
  static loadBlank(driver, url = 'about:blank', duration = 300) {
    const status = {str: 'Resetting state with about:blank', id: 'aboutblank'};
    log.time(status);
    return driver.gotoURL(url)
      .then(_ => new Promise(resolve => setTimeout(resolve, duration)))
      .then(_ => log.timeEnd(status));
  }

  /**
   * Loads options.url with specified options. If the main document URL
   * redirects, options.url will be updated accordingly. As such, options.url
   * will always represent the post-redirected URL. options.initialUrl is the
   * pre-redirect starting URL.
   * @param {!Driver} driver
   * @param {!Object} options
   * @return {!Promise}
   */
  static loadPage(driver, options) {
    return driver.gotoURL(options.url, {
      waitForLoad: true,
      disableJavaScript: !!options.disableJavaScript,
      flags: options.flags,
      config: options.config,
    }).then(finalUrl => {
      options.url = finalUrl;
    });
  }

  /**
   * @param {!Driver} driver
   * @param {!GathererResults} gathererResults
   * @param {!Object} options
   * @return {!Promise}
   */
  static setupDriver(driver, gathererResults, options) {
    const status = {str: 'Initializing…', id: 'gatherrunner-init'};
    log.time(status);
    const resetStorage = !options.flags.disableStorageReset;
    // Enable emulation based on flags
    return driver.assertNoSameOriginServiceWorkerClients(options.url)
      .then(_ => driver.getUserAgent())
      .then(userAgent => {
        gathererResults.UserAgent = [userAgent];
        GatherRunner.warnOnHeadless(userAgent, gathererResults);
      })
      .then(_ => driver.beginEmulation(options.flags))
      .then(_ => driver.enableRuntimeEvents())
      .then(_ => driver.cacheNatives())
      .then(_ => driver.registerPerformanceObserver())
      .then(_ => driver.dismissJavaScriptDialogs())
      .then(_ => resetStorage && driver.clearDataForOrigin(options.url))
      .then(_ => log.timeEnd(status));
  }

  static disposeDriver(driver) {
    const status = {str: 'Disconnecting from browser...', id: 'gatherrunner-disconnect'};
    log.time(status);
    return driver.disconnect().catch(err => {
      // Ignore disconnecting error if browser was already closed.
      // See https://github.com/GoogleChrome/lighthouse/issues/1583
      if (!(/close\/.*status: 500$/.test(err.message))) {
        log.error('GatherRunner disconnect', err.message);
      }
      log.timeEnd(status);
    });
  }

  /**
   * Test any error output from the promise, absorbing non-fatal errors and
   * throwing on fatal ones so that run is stopped.
   * @param {!Promise<*>} promise
   * @return {!Promise<*>}
   */
  static recoverOrThrow(promise) {
    return promise.catch(err => {
      if (err.fatal) {
        throw err;
      }
    });
  }

  /**
   * Throws an error if the original network request failed or wasn't found.
   * @param {string} url The URL of the original requested page.
   * @param {{online: boolean}} driver
   * @param {!Array<WebInspector.NetworkRequest>} networkRecords
   */
  static assertPageLoaded(url, driver, networkRecords) {
    if (!driver.online) return;

    const mainRecord = networkRecords.find(record => {
      // record.url is actual request url, so needs to be compared without any URL fragment.
      return URL.equalWithExcludedFragments(record.url, url);
    });

    let errorMessage;
    if (!mainRecord) {
      errorMessage = 'no document request found';
    } else if (mainRecord.failed) {
      errorMessage = `failed document request (${mainRecord.localizedFailDescription})`;
    }

    if (errorMessage) {
      log.error('GatherRunner', errorMessage, url);
      const error = new Error(`Unable to load page: ${errorMessage}`);
      error.code = 'PAGE_LOAD_ERROR';
      throw error;
    }
  }

  /**
   * Add run warning if running in Headless Chrome.
   * @param {string} userAgent
   * @param {!GathererResults} gathererResults
   */
  static warnOnHeadless(userAgent, gathererResults) {
    if (userAgent.startsWith('HeadlessChrome')) {
      gathererResults.LighthouseRunWarnings.push('Your site\'s mobile performance may be ' +
          'worse than the numbers presented in this report. Lighthouse could not test on a ' +
          'mobile connection because Headless Chrome does not support network throttling.');
    }
  }

  /**
   * Navigates to about:blank and calls beforePass() on gatherers before tracing
   * has started and before navigation to the target page.
   * @param {!Object} options
   * @param {!GathererResults} gathererResults
   * @return {!Promise}
   */
  static beforePass(options, gathererResults) {
    const blockedUrls = (options.config.blockedUrlPatterns || [])
      .concat(options.flags.blockedUrlPatterns || []);
    const blankPage = options.config.blankPage;
    const blankDuration = options.config.blankDuration;
    const pass = GatherRunner.loadBlank(options.driver, blankPage, blankDuration)
        // Set request blocking before any network activity
        // No "clearing" is done at the end of the pass since blockUrlPatterns([]) will unset all if
        // neccessary at the beginning of the next pass.
        .then(() => options.driver.blockUrlPatterns(blockedUrls));

    return options.config.gatherers.reduce((chain, gatherer) => {
      const status = {
        str: `Retrieving setup: ${gatherer.name}`,
        id: `gather-${gatherer.name}-before`,
      };
      return chain.then(_ => {
        log.time(status);
        const artifactPromise = Promise.resolve().then(_ => gatherer.beforePass(options));
        gathererResults[gatherer.name] = [artifactPromise];
        return GatherRunner.recoverOrThrow(artifactPromise);
      }).then(_ => {
        log.timeEnd(status);
      });
    }, pass);
  }

  /**
   * Navigates to requested URL and then runs pass() on gatherers while trace
   * (if requested) is still being recorded.
   * @param {!Object} options
   * @param {!GathererResults} gathererResults
   * @return {!Promise}
   */
  static pass(options, gathererResults) {
    const driver = options.driver;
    const config = options.config;
    const gatherers = config.gatherers;

    const recordTrace = config.recordTrace;
    const isPerfRun = !options.flags.disableStorageReset && recordTrace && config.useThrottling;

    const status = {
      str: 'Loading page & waiting for onload',
      id: 'gatherrunner-loading',
      args: [gatherers.map(g => g.name).join(', ')],
    };
    log.time(status);

    const pass = Promise.resolve()
      // Clear disk & memory cache if it's a perf run
      .then(_ => isPerfRun && driver.cleanBrowserCaches())
      // Always record devtoolsLog
      .then(_ => driver.beginDevtoolsLog())
      // Begin tracing if requested by config.
      .then(_ => recordTrace && driver.beginTrace(options.flags))
      // Navigate.
      .then(_ => GatherRunner.loadPage(driver, options))
      .then(_ => log.timeEnd(status, 'log'));

    return gatherers.reduce((chain, gatherer) => {
      const status = {
        str: `Retrieving in-page: ${gatherer.name}`,
        id: `gather-${gatherer.name}-pass`,
      };
      return chain.then(_ => {
        log.time(status);
        const artifactPromise = Promise.resolve().then(_ => gatherer.pass(options));
        gathererResults[gatherer.name].push(artifactPromise);
        return GatherRunner.recoverOrThrow(artifactPromise);
      }).then(_ => {
        log.timeEnd(status);
      });
    }, pass);
  }

  /**
   * Ends tracing and collects trace data (if requested for this pass), and runs
   * afterPass() on gatherers with trace data passed in. Promise resolves with
   * object containing trace and network data.
   * @param {!Object} options
   * @param {!GathererResults} gathererResults
   * @return {!Promise}
   */
  static afterPass(options, gathererResults) {
    const driver = options.driver;
    const config = options.config;
    const gatherers = config.gatherers;
    const passData = {};

    let pass = Promise.resolve();

    if (config.recordTrace) {
      const status = {str: 'Retrieving trace', id: `gatherrunner-trace`};
      pass = pass.then(_ => {
        log.time(status);
        return driver.endTrace();
      }).then(traceContents => {
        // Before Chrome 54.0.2816 (codereview.chromium.org/2161583004),
        // traceContents was an array of trace events; after, traceContents is
        // an object with a traceEvents property. Normalize to object form.
        passData.trace = Array.isArray(traceContents) ?
            {traceEvents: traceContents} : traceContents;
        log.timeEnd(status);
      });
    }

    pass = pass.then(_ => {
      const status = {str: 'Retrieving devtoolsLog and network records', id: `gatherrunner-log`};
      log.time(status);
      const devtoolsLog = driver.endDevtoolsLog();
      const networkRecords = NetworkRecorder.recordsFromLogs(devtoolsLog);
      GatherRunner.assertPageLoaded(options.url, driver, networkRecords);
      log.timeEnd(status);

      // Expose devtoolsLog and networkRecords to gatherers
      passData.devtoolsLog = devtoolsLog;
      passData.networkRecords = networkRecords;
    });

    // Disable throttling so the afterPass analysis isn't throttled
    pass = pass.then(_ => driver.setThrottling(options.flags, {useThrottling: false}));

    pass = gatherers.reduce((chain, gatherer) => {
      const status = {str: `Retrieving: ${gatherer.name}`, id: `gather-${gatherer.name}-after`};
      return chain.then(_ => {
        log.time(status);
        const artifactPromise = Promise.resolve().then(_ => gatherer.afterPass(options, passData));
        gathererResults[gatherer.name].push(artifactPromise);
        return GatherRunner.recoverOrThrow(artifactPromise);
      }).then(_ => {
        log.timeEnd(status);
      });
    }, pass);

    // Resolve on tracing data using passName from config.
    return pass.then(_ => passData);
  }

  /**
   * Takes the results of each gatherer phase for each gatherer and uses the
   * last produced value (that's not undefined) as the artifact for that
   * gatherer. If a non-fatal error was rejected from a gatherer phase,
   * uses that error object as the artifact instead.
   * @param {!GathererResults} gathererResults
   * @return {!Promise<!Artifacts>}
   */
  static collectArtifacts(gathererResults) {
    const artifacts = {};

    // Nest LighthouseRunWarnings, if any, so they will be collected into artifact.
    gathererResults.LighthouseRunWarnings = [gathererResults.LighthouseRunWarnings];

    return Object.keys(gathererResults).reduce((chain, gathererName) => {
      return chain.then(_ => {
        const phaseResultsPromises = gathererResults[gathererName];
        return Promise.all(phaseResultsPromises).then(phaseResults => {
          // Take last defined pass result as artifact.
          const definedResults = phaseResults.filter(element => element !== undefined);
          const artifact = definedResults[definedResults.length - 1];
          if (artifact === undefined) {
            throw new Error(`${gathererName} failed to provide an artifact.`);
          }
          artifacts[gathererName] = artifact;
        }, err => {
          // To reach this point, all errors are non-fatal, so return err to
          // runner to handle turning it into an error audit.
          artifacts[gathererName] = err;
        });
      });
    }, Promise.resolve()).then(_ => {
      return artifacts;
    });
  }

  static run(passes, options) {
    const driver = options.driver;
    const tracingData = {
      traces: {},
      devtoolsLogs: {},
      networkRecords: {},
    };

    if (typeof options.url !== 'string' || options.url.length === 0) {
      return Promise.reject(new Error('You must provide a url to the gather-runner'));
    }

    if (typeof options.flags === 'undefined') {
      options.flags = {};
    }

    if (typeof options.config === 'undefined') {
      return Promise.reject(new Error('You must provide a config'));
    }

    if (typeof options.flags.disableCpuThrottling === 'undefined') {
      options.flags.disableCpuThrottling = false;
    }

    passes = this.instantiateGatherers(passes, options.config.configDir);

    const gathererResults = {
      LighthouseRunWarnings: [],
    };

    return driver.connect()
      .then(_ => GatherRunner.loadBlank(driver))
      .then(_ => GatherRunner.setupDriver(driver, gathererResults, options))

      // Run each pass
      .then(_ => {
        // If the main document redirects, we'll update this to keep track
        let urlAfterRedirects;
        return passes.reduce((chain, config, passIndex) => {
          const runOptions = Object.assign({}, options, {config});
          return chain
            .then(_ => driver.setThrottling(options.flags, config))
            .then(_ => GatherRunner.beforePass(runOptions, gathererResults))
            .then(_ => GatherRunner.pass(runOptions, gathererResults))
            .then(_ => GatherRunner.afterPass(runOptions, gathererResults))
            .then(passData => {
              const passName = config.passName || Audit.DEFAULT_PASS;

              // networkRecords are discarded and not added onto artifacts.
              tracingData.devtoolsLogs[passName] = passData.devtoolsLog;

              // If requested by config, add trace to pass's tracingData
              if (config.recordTrace) {
                tracingData.traces[passName] = passData.trace;
              }

              if (passIndex === 0) {
                urlAfterRedirects = runOptions.url;
              }
            });
        }, Promise.resolve()).then(_ => {
          options.url = urlAfterRedirects;
        });
      })
      .then(_ => GatherRunner.disposeDriver(driver))
      .then(_ => GatherRunner.collectArtifacts(gathererResults))
      .then(artifacts => {
        // Add tracing data to the artifacts object.
        return Object.assign(artifacts, tracingData);
      })
      // cleanup on error
      .catch(err => {
        GatherRunner.disposeDriver(driver);

        throw err;
      });
  }

  static getGathererClass(nameOrGathererClass, configPath) {
    const Runner = require('../runner');
    const coreList = Runner.getGathererList();

    let GathererClass;
    if (typeof nameOrGathererClass === 'string') {
      const name = nameOrGathererClass;

      // See if the gatherer is a Lighthouse core gatherer.
      const coreGatherer = coreList.find(a => a === `${name}.js`);
      let requirePath = `./gatherers/${name}`;
      if (!coreGatherer) {
        // Otherwise, attempt to find it elsewhere. This throws if not found.
        requirePath = Runner.resolvePlugin(name, configPath, 'gatherer');
      }

      GathererClass = require(requirePath);

      this.assertValidGatherer(GathererClass, name);
    } else {
      GathererClass = nameOrGathererClass;
      this.assertValidGatherer(GathererClass);
    }

    return GathererClass;
  }

  static assertValidGatherer(GathererDefinition, gathererName) {
    const gathererInstance = new GathererDefinition();
    gathererName = gathererName || gathererInstance.name || 'gatherer';

    if (typeof gathererInstance.beforePass !== 'function') {
      throw new Error(`${gathererName} has no beforePass() method.`);
    }

    if (typeof gathererInstance.pass !== 'function') {
      throw new Error(`${gathererName} has no pass() method.`);
    }

    if (typeof gathererInstance.afterPass !== 'function') {
      throw new Error(`${gathererName} has no afterPass() method.`);
    }
  }

  static instantiateGatherers(passes, rootPath) {
    return passes.map(pass => {
      pass.gatherers = pass.gatherers.map(gatherer => {
        // If this is already instantiated, don't do anything else.
        if (typeof gatherer !== 'string') {
          return gatherer;
        }

        const GathererClass = GatherRunner.getGathererClass(gatherer, rootPath);
        return new GathererClass();
      });

      return pass;
    });
  }
}

module.exports = GatherRunner;
