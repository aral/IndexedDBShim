// Todo: Reuse any relevant portions in this file or `node-buildjs.js` for adapting tests for browser shimming
const fs = require('fs');
const path = require('path');
const {goodFiles, badFiles} = require('./node-good-bad-files');
const vm = require('vm');

// CONFIG
const vmTimeout = 5000; // Time until we give up on the vm (increasing to 40000 didn't make a difference on coverage)
// const intervalSpacing = 1; // Time delay after test before running next

// SET-UP
const fileArg = process.argv[2];
const dirPath = path.join('test-support', 'js');
const idbTestPath = 'web-platform-tests';
const scores = {
    Pass: 0,
    Fail: 0,
    Timeout: 0,
    'Not Run': 0
};
const shimTests = {
    Pass: [],
    Fail: [],
    Timeout: [],
    'Not Run': []
};
let ct = 0;

/*
// Todo: Might use in place of excluded array, but would need to increment, etc.
process.on('uncaughtException', function(err) {
    // handle the error safely
    console.log('idbshim uncaught error:' + err)
});
process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});
*/
function readAndEvaluate (jsFiles, initial = '', item = 0) {
    const fileName = jsFiles[item];

    const finished = () => {
        ct += 1;
        function finishedCheck () {
            if (ct < jsFiles.length) {
                // Todo: Have the test environment script itself report back time-outs and
                //    tweak per test? (but set vmTimeout longer in case needed or even
                //    remove if we control it on a per-test basis ourselves)
                // We chain requests to avoid tests having race condition, e.g.,
                //   potentially reusing database name, etc. if not handled already
                //   in the tests (more tests do pass with these timeouts);
                //   the timeout, however, does not even seem to be necessary.
                // setTimeout(() => {
                readAndEvaluate(jsFiles, initial, ++item);
                // }, intervalSpacing);
                return;
            }
            shimTests['Files with all tests passing'] = shimTests.Pass.filter((p) =>
                !shimTests.Fail.includes(p) &&
                !shimTests.Timeout.includes(p) &&
                !shimTests['Not Run'].includes(p)
            );
            console.log('\nTest files by status (may recur):');
            console.log(
                Object.entries(shimTests).reduce((_, [status, files]) => {
                    if (!files.length) {
                        return _ + '  ' + status + ': 0\n';
                    }
                    return _ + '  ' + status + ' (' + files.length + '): [\n    ' + JSON.stringify(files).slice(1, -1) + '\n  ]\n';
                }, '\n')
            );

            console.log('  Number of files processed: ' + ct);

            console.log('\nNumber of total tests by status:');
            scores['Total tests'] = Object.values(scores).reduce((s, score) => s + score);
            console.log(JSON.stringify(scores, null, 2) + '\n');
            process.exit();
        }
        finishedCheck();
    };

    // Exclude those currently breaking the tests
    // Todo: Replace with `uncaughtException` handlers above?
    const excluded = [
        'idb_webworkers.js', // No Worker object
        'idbtransaction_objectStoreNames.js', // Throwing on replacement character in object store name
        'keypath.js', // Circular keypath
        'name-scopes.js', // ES templates
        'transaction-lifetime.js' // Problem creating object store
    ];
    if (excluded.includes(fileName)) {
        finished();
        return;
    }

    fs.readFile(path.join(dirPath, fileName), 'utf8', function (err, content) {
        if (err) { return console.log(err); }

        const scripts = [];
        const supported = [
            'resources/testharness.js', 'resources/testharnessreport.js',
            'resources/idlharness.js', // 'resources/WebIDLParser.js', // Todo: Needs to be built? Asked at https://github.com/w3c/testharness.js/issues/231
            'support.js', 'support-promises.js'
        ];
        // Use paths set in node-buildjs.js (when extracting <script> tags and joining contents)
        content.replace(/beginscript::(.*?)::endscript/g, (_, src) => {
            // Fix paths for known support files and report new ones (so we can decide how to handle)
            if (supported.includes(src) || supported.includes(src.replace(/^\//, ''))) {
                src = src.replace(/^\//, '');
                scripts.push((/^resources\//).test(src) ? src : 'IndexedDB/' + src);
            } else {
                console.log('missing?:' + src);
            }
        });

        readAndJoinFiles(
            scripts.map(
                (resource) => path.join(idbTestPath, resource)
            ),
            function (harnessContent) {
                // This regex replacement ensures that a testharness.js `global_scope` method
                //   used for exposing variables on the global object will work (in conjunction
                //   with our also setting `global` in the vm code as the vm's `this`)
                // Todo: We should be able to copy only those items from jsdom's window that
                //    we need and thereby avoid doing this (fragile) replace here.
                harnessContent = harnessContent.replace(/return window/, 'return global');
                const allContent = initial +
                        // Insert our own reporting once tests ready for evaluation
                        // Todo: Make a PR for testharness to use this (more easily overridable)
                        //   function at this point (for a less fragile solution)
                        harnessContent.replace(
                            /(html \+= "<\/tbody><\/table>";)/,
                            '$1\n' +
                            'reportResults(tests, status_text, assertions, "' +
                                fileName.replace(/"/g, '\\"').replace(/\\/g, '\\\\') +
                            '");\n'
                        ) +
                    '\n' + content;
                try {
                    // Only pass in safe objects
                    const sandboxObj = {
                        // Todo: Remove require, process dependencies!
                        require, process, console, scores, shimTests, finished
                    };
                    vm.runInNewContext(allContent, sandboxObj, {
                        displayErrors: true,
                        timeout: vmTimeout
                    });
                } catch (err) {
                    // If there is an issue, save the last erring test along with our
                    // custom test environment and the harness bundle; avoid some of our
                    //  ESLint rules on this joined file to better notice any other
                    //  issues between the code, custom environment, and harness
                    const fileSave =
                        '/' + '*' + fileName + ':::' + err /* .replace(new RegExp('\\*' + '/', 'g'), '* /') */ + '*' + '/' +
                        '/' + '* globals assert_equals, assert_array_equals, assert_unreached, async_test, EventWatcher, SharedWorkerGlobalScope, DedicatedWorkerGlobalScope, ServiceWorkerGlobalScope, WorkerGlobalScope *' + '/\n' +
                        '/' + '*eslint-disable curly, no-unused-vars, no-self-compare, space-in-parens, no-extra-parens, spaced-comment, padded-blocks, no-useless-escape, func-call-spacing, comma-spacing, operator-linebreak, prefer-const, compat/compat, no-unneeded-ternary, space-unary-ops, object-property-newline, no-multiple-empty-lines, block-spacing, space-infix-ops, comma-dangle, no-template-curly-in-string, yoda, quotes, spaced-comment, no-var, key-spacing, camelcase, indent, semi, space-before-function-paren, eqeqeq, brace-style, no-array-constructor, keyword-spacing*' + '/\n' +
                        allContent;
                    fs.writeFile(path.join('test-support', 'latest-erring-bundled.js'), fileSave, function (err) {
                        if (err) { return console.log(err); }
                    });
                    finished();
                }
            }
        );
    });
}

function readAndEvaluateFiles (err, jsFiles) {
    if (err) { return console.log(err); }
    fs.readFile(path.join('test-support', 'environment.js'), 'utf8', function (err, initial) {
        if (err) { return console.log(err); }

        // console.log(JSON.stringify(jsFiles)); // See what files we've got

        // Hard-coding problematic files for testing
        // jsFiles = ['idb_webworkers.js', 'idbtransaction_objectStoreNames.js'];
        // jsFiles = jsFiles.slice(0, 3);

        /*
        Current test statuses with 5 exclusions (vmTimeout = 5000; increment = vmTimeout + 500):
          "Pass": 510,
          "Fail": 80,
          "Timeout": 0,
          "Not Run": 22,
          "Total tests": 612
        */
        readAndEvaluate(jsFiles, initial);
    });
}

if (fileArg === 'good') {
    readAndEvaluateFiles(null, goodFiles);
} else if (fileArg === 'bad') {
    readAndEvaluateFiles(null, badFiles);
} else if (fileArg && fileArg !== 'all') {
    readAndEvaluate([fileArg]);
} else {
    fs.readdir(dirPath, readAndEvaluateFiles);
}

function readAndJoinFiles (arr, cb, i = 0, str = '') {
    const filename = arr[i];
    if (!filename) { // || i === arr.length - 1) {
        return cb(str);
    }
    fs.readFile(filename, 'utf8', function (err, data) {
        if (err) { return console.log(err); }
        str += '/*jsfilename:' + filename + '*/\n\n' + data;
        readAndJoinFiles(arr, cb, i + 1, str);
    });
}