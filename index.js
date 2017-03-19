#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const commandLineArgs = require("command-line-args");
const commandLineUsage = require("command-line-usage");
const Analyzer = require("polymer-analyzer").Analyzer;
const FSUrlLoader = require("polymer-analyzer/lib/url-loader/fs-url-loader").FSUrlLoader;
const PackageUrlResolver = require("polymer-analyzer/lib/url-loader/package-url-resolver").PackageUrlResolver;

let analyzer = new Analyzer({
  urlLoader: new FSUrlLoader(process.cwd()),
  urlResolver: new PackageUrlResolver()
});
const supportedFeatures = [ "element", "element-mixin", "namespace", "function", "behavior" ];

const reindent = (chunks, ...values) => {
  let str = chunks.slice(0, 1)
    .concat(values.map((v, i) => v + chunks[ i + 1 ]))
    .join("")
    .replace(/\t/g, "  ")   // replace tabs with spaces
    .replace(/\n(\s*\n)+/g, "\n")   // collapse multiple empty lines
    .replace(/^\n?([\S\s]*?)[\n\s]*$/, "$1"); // trim leading new line and ending whitespace
  let tabStart = " ".repeat(Math.min.apply(null, str.match(/^(\s)*/mg).map(t => t.length)));
  return str.replace(new RegExp(`^${tabStart}`, "mg"), "");
};
const jsDoc = (desc, indentLevel = 0) => {
  if (!desc || !desc.length) {
    return "";
  }

  if (!Array.isArray(desc)) {
    desc = desc.split("\n");
  }
//  let tab = "  ".repeat(indentLevel);
  return reindent(indentLevel)`
    /**${desc.map(line => `
     *${line ? ` ${line}` : ""}`).join("")}
     */
  `;
};
const cast = (name, type, params) => {
  let primitives = [ "string", "number", "boolean" ];
  let polymerVoidMethods = [
    "created", "ready", "attached", "detached", "attributeChanged",
    "connectedCallback", "disconnectedCallback", "attributeChangedCallback",
    "updateStyles", "linkPaths", "unlinkPaths", "notifySplices", "set", "setProperties"
  ];
  if (primitives.includes(type)) {
    return { returnType: type };
  }
  if (type === "Function") {
    let returnType = polymerVoidMethods.includes(name) ? "void" : "any";
    return {
      returnType,
      methodParams: (params || []).map(param => `${param.name}: any`)
    };
  }
  return {
    returnType: type === "Array" ? "Array<any>" : "any"
  };
};

const filterFeatures = feature => Array.from(feature.kinds.keys()).some(key => supportedFeatures.includes(key));
const getFeatureDetails = feature => {
  let name;
  let namespace = null;
  let cNameParts = feature.className && feature.className.split(".");
  if (cNameParts) {
    [ namespace, name ] = [ cNameParts.slice(0, -1).join("."), cNameParts.slice(-1)[ 0 ] ];
  } else {
    name = feature.tagName;
  }
  let camelName = name.replace(/(?:^|-)(.)/g, (_, m) => m.toUpperCase());
  return {
    namespace, name: camelName,
    module: feature.sourceRange.file,
    jsdoc: feature.description ? feature.description.trim() : null,
    properties: feature.properties
      .filter((property) => !property.private)
      .map(({ name, type, readOnly, params, description }) => {
        let { returnType, methodParams } = cast(name, type, params);
        return {
          jsDoc: description ? description.trim() : null,
          readonly: readOnly ? "readonly " : "",
          type: returnType,
          params: methodParams,
          name
        };
      })
      .concat({ jsDoc: "", readonly: "", name: "new", params: [], type: camelName })
  };
};
const toModulesMap = features => features.reduce((map, feature) => {
  let repos = {
    bower_components: "bower:",
    node_modules: "npm:"
  };
  let modulePath = feature.module
    .replace(new RegExp(`(${Object.keys(repos).join("|")})\\/`), (_, repo) => (repos)[ repo ])
    .concat(feature.namespace ? `#${feature.namespace}` : "");
  if (!map[ modulePath ]) {
    map[ modulePath ] = [];
  }
  map[ modulePath ].push(feature);
  return map;
}, {});
const buildModules = modulesMap => {
  return Object
    .keys(modulesMap)
    .map((modulePath) => [ modulePath, modulesMap[ modulePath ] ])
    .map(([ modulePath, members ]) => reindent`
      declare module "${modulePath}" {
      ${members.map(({ jsdoc, name, properties }) => `
        ${jsdoc ? `
        /**${jsdoc.split("\n").map(line => `
         *${line ? ` ${line}` : ""}`).join("")}
         */`
      : ""}
        export interface ${name} {
        ${properties.map(({ jsDoc, readonly, name, params, type }) => `
          ${jsDoc ? `
          /**${jsDoc.split("\n").map(line => `
           *${line ? ` ${line}` : ""}`).join("")}
           */`
      : ""}
          ${readonly}${name}${params ? `(${params.join(", ")})` : ""}: ${type};`).join("\n")}
        }`).join("\n")}
      }`);
};
const splitModulesToFiles = modulesMap => Object
  .keys(modulesMap)
  .map((mod) => modulesMap[ mod ])
  .reduce((filesMap, mod) => {
    let path = mod.match(/declare module "([^"#]*)["#]/)[ 1 ];
    if (!filesMap[ path ]) {
      filesMap[ path ] = {
        fileName: path.match(/(?:[^:]*:)?(?:[^\/]+\/)*(.*)\.html/)[ 1 ],
        modules: []
      };
    }
    filesMap[ path ].modules.push(mod);
    return filesMap;
  }, {});

const cliOptions = [
  {
    name: "help",
    alias: "h",
    type: Boolean,
    description: "Shows this help"
  },
  {
    name: "outDir",
    alias: "d",
    type: String,
    description: "Output all declarations to this folder",
    defaultValue: "types"
  },
  {
    name: "input",
    type: String,
    multiple: false,
    defaultOption: true
  }
];

/** @property outDir */
let cli;

try {
  cli = commandLineArgs(cliOptions);
} catch (e) {
  console.error(e.message);
  process.exit(-1);
}
if (cli.help) {
  const packageJSON = require("./package.json");
  const execName = Object.keys(packageJSON.bin)[ 0 ];
  console.log(commandLineUsage([
    {
      header: "Polymer To TypeScript docs converter",
      content: packageJSON.description
    },
    {
      header: "Syntax",
      content: `${execName} [options] [file ...]`
    },
    {
      header: "Examples",
      content: [
        `${execName} my-element.html`,
        `${execName} --outDir types my-element.html`,
        `${execName} --output types.d.ts my-element.html`
      ].join("\n")
    },
    {
      header: "Options", optionList: cliOptions.slice(0, -1)
    }
  ]));
  process.exit(0);
}

if (!fs.existsSync(cli.outDir)) {
  fs.mkdirSync(cli.outDir);
}

analyzer
  .analyze(cli.input)
  .then((document) => Array.from(document.getFeatures()).filter(filterFeatures).map(getFeatureDetails))
  .then(toModulesMap)
  .then(buildModules)
  .then(splitModulesToFiles)
  .then(filesMap => Promise.all(Object.keys(filesMap)
    .map(filePath => new Promise((done, fail) => {
      let fileInfo = filesMap[ filePath ];
      return fs.writeFile(
        path.join(cli.outDir, `${fileInfo.fileName}.d.ts`),
        `${fileInfo.modules.join("\n\n")}\n`,
        (err) => err ? fail(err) : done());
    }))
  ))
  .then(() => {
    console.log("done");
    process.exit(0);
  })
  .catch(err => {
    console.log(err);
    process.exit(-1);
  });
