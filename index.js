'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var _ = require('lodash');
var tmp = require('tmp');
var slash = require('slash');
var penthouse = require('penthouse');
var CleanCSS = require('clean-css');
var oust = require('oust');
var sourceInliner = require('inline-critical');
var imageInliner = require('imageinliner');
/* jshint -W079 */
var Promise = require('bluebird');
var tempfile = require('tempfile');
var inliner = require('./lib/inline-styles');


// promisify fs and penthouse
Promise.promisifyAll(fs);
var penthouseAsync = Promise.promisify(penthouse);
var tmpfile = Promise.promisify(tmp.file);

tmp.setGracefulCleanup();

/**
 * returns a string of combined and deduped css rules.
 * @param cssArray
 * @returns {String}
 */
function combineCss(cssArray) {
    if (cssArray.length == 1) {
        return cssArray[0].toString();
    }

    return new CleanCSS({mediaMerging: true}).minify(
        _.invoke(cssArray, 'toString')
            .join(' ')
    );
}

/**
 * get path from result array
 * @param resultArray
 * @returns {*}
 */
function resolveTmp(resultArray) {
    return _.first(resultArray);
}

/**
 * Fixup slashes in file paths for windows
 */
function normalizePath(str) {
    return process.platform === 'win32' ? slash(str) : str;
}

/**
 * Get content based on options
 * could either be a html string or a local file
 * @param opts
 * @returns {{promise: *, tmpfiles: Array}}
 */
function getContentPromise(opts) {
    // html passed in directly -> create tmp file and set opts.url
    if (opts.html) {
        return tmpfile({dir: opts.base, postfix: '.html'})
            .then(resolveTmp)
            .then(function (path) {
                opts.url = path;
                return fs.writeFileAsync(opts.url, opts.html).then(function () {
                    return opts.html;
                });
            });
        // use src file provided
    } else {
        // src can either be absolute or relative to opts.base
        if (opts.src !== path.resolve(opts.src)) {
            opts.url = path.join(opts.base, opts.src);
        } else {
            opts.url = path.relative(process.cwd(), opts.src);
        }

        return fs.readFileAsync(opts.url);
    }
}


/**
 * Critical path CSS generation
 * @param  {object} opts Options
 * @param  {function} cb Callback
 * @accepts src, base, width, height, dimensions, dest
 */
exports.generate = function (opts, cb) {
    opts = opts || {};
    cb = cb || function () {};

    if (!(opts.src || opts.html) || !opts.base) {
        throw new Error('A valid source and base path are required.');
    }

    if (!opts.dimensions) {
        opts.dimensions = [{
            height: opts.height || 1300,
            width: opts.width || 900
        }];
    }

    Promise.map(opts.dimensions, function (dimensions) {
        // use content to fetch used css files
        return getContentPromise(opts).then(function (html) {
            // consider opts.css and map to array if it's a string
            if (opts.css) {
                return typeof opts.css === 'string' ? [opts.css] : opts.css;
            }

            // Oust extracts a list of your stylesheets (ignoring remote stylesheets)
            return oust(html.toString(), 'stylesheets').filter(function (href) {
                return !/(^\/\/)|(:\/\/)/.test(href);
            }).map(function (href) {
                return path.join(opts.base, href);
            });
            // read files
        }).map(function (fileName) {
            return fs.readFileAsync(fileName, 'utf8').then(function (content) {
                // get path to css file
                var dir = path.dirname(fileName);
                var maxFileSize = opts.maxImageFileSize || 10240;

                // #40 already inlined background images cause problems with imageinliner
                if (opts.inlineImages) {
                    content = imageInliner.css(content.toString(), {
                        maxImageFileSize: maxFileSize,
                        cssBasePath: dir,
                        rootImagePath: opts.base
                    });
                }
                // normalize relative paths
                return content.toString().replace(/url\(['"]?([^'"\)]+)['"]?\)/g, function (match, filePath) {
                    // do nothing for absolute paths, urls and data-uris
                    if (/^data\:/.test(filePath) || /(?:^\/)|(?:\:\/\/)/.test(filePath)) {
                        return match;
                    }

                    // create path relative to opts.base
                    var relativeToBase = path.relative(path.resolve(opts.base), path.resolve(path.join(dir, filePath)));

                    // prepend / to make it absolute
                    return normalizePath(match.replace(filePath, path.join('/', relativeToBase)));
                });
            });

            // combine all css files to one bid stylesheet
        }).reduce(function (total, contents) {
            return total + os.EOL + contents;

            // write contents to tmp file
        }, '').then(function (css) {
            var csspath = tempfile('.css');
            return fs.writeFileAsync(csspath, css).then(function () {
                return csspath;
            });
            // let penthouseAsync do the rest
        }).then(function (csspath) {
            return penthouseAsync({
                url: normalizePath(opts.url),
                css: csspath,
                // What viewports do you care about?
                width: dimensions.width,   // viewport width
                height: dimensions.height  // viewport height
            });
        });
    }).then(function (criticalCSS) {
        criticalCSS = combineCss(criticalCSS);

        if (opts.minify === true) {
            criticalCSS = new CleanCSS().minify(criticalCSS);
        }

        if (opts.dest) {
            // Write critical-path CSS
            return fs.writeFileAsync(path.join(opts.base, opts.dest), criticalCSS).then(function () {
                return criticalCSS;
            });
        } else {
            return criticalCSS;
        }
    }).catch(function (err) {
        cb(err);
        throw new Promise.CancellationError();
    }).then(function (finalCss) {
        cb(null, finalCss);
    }).catch(Promise.CancellationError,function(){}).done();
};

/**
 * Critical path CSS inlining
 * @param  {object} opts Options
 * @param  {function} cb Callback
 * @accepts src, base, dest
 */
exports.inline = function (opts, cb) {
    opts = opts || {};
    cb = cb || function () {};

    if (!opts.src || !opts.base) {
        throw new Error('A valid source and base path are required.');
    }

    // Inline the critical path CSS
    fs.readFile(path.join(opts.base, opts.src), function (err, data) {
        if (err) {
            cb(err);
            return;
        }

        var out = inliner(data, opts);

        if (opts.dest) {
            // Write HTML with inlined CSS to dest
            fs.writeFile(path.join(opts.base, opts.dest), out, function (err) {
                if (err) {
                    cb(err);
                    return;
                }

                cb(null, out.toString());
            });
        } else {
            cb(null, out.toString());
        }
    });
};

/**
 * Generate and inline critical-path CSS
 * @param  {object} opts Options
 * @param  {function} cb Callback
 * @accepts src, base, width, height, styleTarget, htmlTarget
 */
exports.generateInline = function (opts, cb) {
    opts = opts || {};
    cb = cb || function () {};

    var genOpts = opts;
    genOpts.dest = opts.styleTarget || '';

    exports.generate(genOpts, function (err, output) {
        if (err) {
            cb(err);
            return;
        }

        // Inline generated css
        getContentPromise(opts).then(function (html) {
            return sourceInliner(html, output, {
                minify: opts.minify || false,
                extract: opts.extract || false,
                basePath: opts.base || process.cwd()
            });
        }).then(function (final) {
            if (opts.htmlTarget) {
                return fs.writeFileAsync(path.join(opts.base, opts.htmlTarget), final).then(function () {
                    return final;
                });
            } else {
                return final;
            }
            // error callback
        }).catch(function (err) {
            cb(err);
            // callback success
        }).then(function (final) {
            cb(null, final.toString());
        }).done();
    });
};
