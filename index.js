'use strict'
let fs = require('fs')
const path = require('path')
const markdown = require('nunjucks-markdown')
const marked = require('marked')
const Minimize = require('minimize')
const nunjucks = require('nunjucks')
const stylus = require('stylus')

const getMimeType = require(path.join(__dirname, 'lib/utils.js')).getMimeType
const readFile = require(path.join(__dirname, 'lib/utils.js')).readFile
const logAndExit = require(path.join(__dirname, 'lib/utils.js')).logAndExit.bind(null, 'raml2html')

const getCurlStatement = require(path.join(__dirname, 'lib/stylus-globals.js')).getCurlStatement
const getLanguage = require(path.join(__dirname, 'lib/stylus-globals.js')).getLanguage
const getResponseHeaders = require(path.join(__dirname, 'lib/stylus-globals.js')).getResponseHeaders
const getSafeId = require(path.join(__dirname, 'lib/stylus-globals.js')).getSafeId
const hasExamples = require(path.join(__dirname, 'lib/stylus-globals.js')).hasExamples
const getTypeDefinitions = require(path.join(__dirname, 'lib/stylus-globals.js')).getTypeDefinitions
const hasType = require(path.join(__dirname, 'lib/stylus-globals.js')).hasType
const getType = require(path.join(__dirname, 'lib/stylus-globals.js')).getType

require(path.join(__dirname, 'lib/array-includes-polyfil.js'))()

let minimize = new Minimize({quotes: true})
const templatesPath = path.join(__dirname, 'templates')
const DEFAULT_LOGO = path.join(templatesPath, 'images', 'logo.png')
const DEFAULT_COLOR_THEME = path.join(templatesPath, 'css', '_variables.styl.default')
const DEFAULT_LANGUAGE_TABS = ['json']

let mdRenderer = new marked.Renderer()
mdRenderer.hr = () => `</div><div class="set-examples">`
mdRenderer.code = (text, language) => `<pre><code class="lang-${language} hljs">${text}</code></pre>`
marked.setOptions({renderer: mdRenderer})

/**
 * Renders a parsed RAML object into the templatesPath
 * @param  {object}          ramlObj A parsed RAML object as produced by raml2obj
 * @param  {object}          config  A map with raml2html configuration
 *                                   (create a typedef for this and validate)
 * @return {Promise<string>}         A Promise resolving to html as a string
 */
function processRamlObj (ramlObj, config) {
  return Promise.all([
    renderCss(templatesPath, config.colorThemePath),
    loadLogo(config.logoPath)
  ])
    .then((data) => {
      ramlObj.css = data[0]
      ramlObj.logo = data[1]
      ramlObj.logoMime = getMimeType(config.logoPath)
      ramlObj.languageTabs = config.languageTabs.length > 1 ? config.languageTabs : undefined
      ramlObj.isLowPriorityArticle = (config.lowPriorityArticles || []).reduce((result, article) => ({ ...result, [article]: true }), {})
      ramlObj.search = true

      return renderHtml(templatesPath, ramlObj)
    })
}

/**
 * Renders the stylus sheets along with the supplied theme into a css string
 * @param  {string}          basePath       The folder in which stylus references are resolved
 * @param  {string}          colorThemePath The path to _variables.styl
 * @return {Promise<string>}                A Promise resolving to the css stylesheet as a string
 */
function renderCss (basePath, colorThemePath) {
  // TODO: figure out how we can get load this from user config options
  const stylusPath = path.join(basePath, 'css', 'style.styl')
  return Promise.all([readFile(colorThemePath), readFile(stylusPath)])
    .then((stylusFiles) => {
      return new Promise((resolve, reject) => {
        stylus.render(
          stylusFiles.map((item) => item.toString('utf8')).join(''),
          {paths: [path.join(basePath, 'css')]},
          (err, css) => err ? reject(err) : resolve(css)
        )
      })
    })
}

/**
 * Read the logo at logoPath and return the contents as a base64 encoded string
 * @param  {string}          logoPath The path of the logo
 * @return {Promise<string>}          A Promise resolving to the base64 encoded content of the logo
 */
function loadLogo (logoPath) {
  return readFile(logoPath).then((buffer) => buffer.toString('base64'))
}

/**
 * Render the ramlObj into the nunjucks template and return the resulting
 * HTML as a string
 * @param  {string} basePath The directory in which nunjucks references are resolved
 * @param  {object} ramlObj  A ramlObj with some additional properties for logo and css
 * @return {string}          The final HTML
 */
function renderHtml (basePath, ramlObj) {
  const template = path.join(basePath, 'root.nunjucks')
  const env = nunjucks
    .configure(basePath, {autoescape: false})
    .addGlobal('getSafeId', getSafeId)
    .addGlobal('getLanguage', getLanguage)
    .addGlobal('getResponseHeaders', getResponseHeaders)
    .addGlobal('getCurlStatement', getCurlStatement.bind(null, ramlObj.securitySchemes, ramlObj.baseUri))
    .addGlobal('hasExamples', hasExamples)
    .addGlobal('getTypeDefinitions', getTypeDefinitions)
    .addGlobal('hasType', hasType)
    .addGlobal('getType', getType)
  markdown.register(env, marked)
  return env.render(template, ramlObj)
}

/**
 * Minimize the HTML
 * @param  {string}          data The HTML generated by the theme
 * @return {Promise<string>}      A Promise resolving to the minimized HTML
 */
function postProcessHtml (data) {
  return new Promise((resolve, reject) => {
    minimize.parse(data, (err, html) => err ? reject(err) : resolve(html))
  })
}

function configureTheme (args) {
  args = args || {}
  if (args['generate-color-theme']) {
    let defaultTheme = fs.readFileSync(DEFAULT_COLOR_THEME, {encoding: 'utf8'})
    fs.writeSync(1, defaultTheme)
    fs.fsyncSync(1)
    process.exit(0)
  }

  const logoPath = args['logo'] || DEFAULT_LOGO
  const colorThemePath = args['color-theme'] || DEFAULT_COLOR_THEME
  const languageTabs = validateStringArray(args['language-tabs'] || DEFAULT_LANGUAGE_TABS)
  const lowPriorityArticles = validateStringArray(args['low-articles'] || [])

  return {
    colorThemePath,
    languageTabs,
    logoPath,
    processRamlObj,
    postProcessHtml,
    lowPriorityArticles
  }
}

/**
 * TODO: add tests
 * Convert the `language-tabs` commandline argument into an Array of strings
 * @param  {string|array} arg  The argument as passed on the commandline or in the config object
 * @return {array<string>}     An array of strings for the language tabs
 * @throws {TypeError}         Throws a TypeError if the argument does not pass input validation
 */
function validateStringArray (arg) {
  let result

  if (typeof arg === 'string') {
    arg = arg === '' ? '[]' : arg
    try {
      result = JSON.parse(arg)
    } catch (e) {
      if (e instanceof SyntaxError) {
        logAndExit(arg)
      } else {
        throw e
      }
    }
  } else {
    result = arg
  }

  if (!Array.isArray(result)) {
    logAndExit(arg)
  }

  result.forEach((item) => {
    if (typeof item !== 'string') {
      logAndExit(arg)
    }
  })

  return result
}

module.exports = configureTheme
