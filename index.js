#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const commandLineArgs = require("command-line-args");
const commandLineUsage = require("command-line-usage");
const Analyzer = require("polymer-analyzer").Analyzer;
const FSUrlLoader = require("polymer-analyzer/lib/url-loader/fs-url-loader").FSUrlLoader;
const PackageUrlResolver = require("polymer-analyzer/lib/url-loader/package-url-resolver").PackageUrlResolver;

const analyzer = new Analyzer({
  urlLoader: new FSUrlLoader(process.cwd()),
  urlResolver: new PackageUrlResolver()
});
const supportedFeatures = [ "element", "element-mixin", "behavior" ];

function parseType(type, forceArray) {
  if (/^[!?]/.test(type)) {
    type = type.slice(1);
  }

  if (/=$/.test(type)) {
    type = type.slice(0, -1);
  }

  if (type === "Array") {
    type += "<any>";
  } else if (![ "Date", "string", "boolean", "number", "Symbol" ].includes(type)) {
    type = "any";
  }

  return forceArray ? `Array<${type}>` : type;
}

function indent(tabs) {
  const indentString = typeof tabs === "number" ? " ".repeat(tabs) : tabs;
  return (chunks, ...vars) => {
    return (typeof chunks === "string" ? [ chunks ] : chunks)
      .reduce((src, chunk, i) => src + vars[ i - 1 ] + chunk)
      .split("\n")
      .map((line) => /^\s*$/.test(line) && typeof tabs === "number" ? "" : (indentString + line).replace(/\s*$/, ""))
      .join("\n");
  };
}

function printJSdoc({ description, tags }) {
  const nonEmptyTags = tags && tags.filter((tag) => tag.title !== "type" || tag.type.name);
  return description || nonEmptyTags && nonEmptyTags.length ? `
/**${indent(" * ")(description.trim())}${description.trim() && nonEmptyTags.length ? `
 *` : ""}${nonEmptyTags.map((tag) => `
 * @${[
    tag.title,
    ...(tag.type && tag.type.name ? [ `{${tag.type.name}}` ] : []),
    tag.name,
    (tag.description || "").trim()
  ].filter((t) => !!t).join(" ")}`).join("")}
 */` : "";
}

function printMethod(method) {
  const returnType = method.return ? `: ${parseType(method.return.type)}` : "";
  const JSDoc = printJSdoc(method.jsdoc);
  const params = method.params.map(({ name, type }) => `${name}: ${parseType(type, name.startsWith("..."))}`).join(", ");
  return indent(4)`${JSDoc}\n${method.name}(${params})${returnType};`;
}

function printProperty(property) {
  const JSDoc = printJSdoc(property.jsdoc);
  let type = property.type;
  return indent(4)`${JSDoc}\n${property.name}${type.startsWith("?") ? "?" : ""}: ${parseType(type)};`;
}

function printElement(declaration) {
  return `${indent(2)(printJSdoc(declaration.jsDoc))}
  export class ${declaration.name} {${
    declaration.properties.join("\n")}${
    declaration.methods.join("\n")}
  }`;
}

function printBehavior(declaration) {
  return `${indent(2)(printJSdoc(declaration.jsDoc))}
  export interface ${declaration.name} {${
    declaration.properties.join("\n")}${
    declaration.methods.join("\n")}
    new (...args): ${declaration.name};
  }
  export const ${declaration.name}: ${declaration.name};`;
}

function printMixin(declaration) {
  return `${indent(2)(printJSdoc(declaration.jsDoc))}
  export function ${declaration.name}<T extends object>(Base: { new (...args: any[]): T }): {
    new (...args: any[]): T & {${indent(2)`${
    declaration.properties.join("\n")}${
    declaration.methods.join("\n")}`}
    }
  };`;
}

const filterFeatures = feature => Array.from(feature.kinds.keys()).some(key => supportedFeatures.includes(key));

const getFeatureDetails = feature => {
  const [ , namespace = null, identifier ] = (feature.identifiers.values().next().value || "").match(/(?:([\w]+)\.)?(.*)/);

  const name = identifier.replace(/(?:^|-)(.)/g, (_, m) => m.toUpperCase());
  const jsDoc = feature.jsdoc || {};

  const repos = {
    bower_components: "bower:",
    node_modules: "npm:"
  };

  if (namespace) {
    if (!jsDoc.tags) {
      jsDoc.tags = [];
    }
    jsDoc.tags.push({ title: "namespace", name: namespace });
  }

  return Object.assign(
    {
      namespace, name, jsDoc, kinds: feature.kinds,
      fileName: feature.sourceRange.file,
      module: feature.sourceRange.file.replace(new RegExp(`(${Object.keys(repos).join("|")})\\/`), (_, repo) => (repos)[ repo ])
    },
    feature.methods ? {
      methods: Array
        .from((feature.methods).values())
        .filter((method) => method.privacy === "public")
        .map(printMethod)
    } : null,
    feature.properties ? {
      properties: Array
        .from(feature.properties.values())
        .filter((prop) => prop.privacy === "public")
        .filter((prop) => prop.type !== "Conditional")
        .map(printProperty)
    } : null
  );
};

const cliOptions = [
  {
    name: "help",
    alias: "h",
    type: Boolean,
    description: "Shows this help"
  },
  {
    name: "outFile",
    alias: "o",
    type: String,
    description: "Output all declarations to a single file",
    defaultValue: "potts.d.ts"
  },
  {
    name: "input",
    type: String,
    multiple: true,
    defaultOption: true
  }
];

/**
 * @property outFile
 */
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
        `${execName}`,
        `${execName} my-element.html`,
        `${execName} --outFile types.d.ts`,
        `${execName} --outFile types.d.ts my-element.html`
      ].join("\n")
    },
    {
      header: "Options", optionList: cliOptions.slice(0, -1)
    }
  ]));
  process.exit(0);
}

if (!cli.input) {
  const bower = JSON.parse(fs.readFileSync(path.join(process.cwd(), "bower.json"), "utf-8"));
  cli.input = Object
    .keys(bower.dependencies || {})
    .map((dep) => {
      const config = JSON.parse(fs.readFileSync(path.join("./bower_components", dep, "bower.json"), "utf-8"));
      if (!Array.isArray(config.main)) {
        config.main = [ config.main ];
      }
      return config.main.map((file) => path.join("bower_components", dep, file));
    })
    .reduce((all, curr) => all.concat(curr), []);
}

analyzer
  .analyze([].concat(cli.input))
  .catch(console.error)
  .then((document) => Array
    .from(document.getFeatures())
    .filter(filterFeatures)
    .map(getFeatureDetails))
  .then((data) => data
    .reduce((map, mod) => {
      if (map.has(mod.module)) {
        map.get(mod.module).push(mod);
      } else {
        map.set(mod.module, [ mod ]);
      }
      return map;
    }, new Map()))
  .then((data) => {
    let types = Array
      .from(data.entries())
      .map(([ path, contents ]) => {
        const moduleContents = contents.map((declaration) => {
          if (declaration.kinds.has("element")) {
            return printElement(declaration);
          }
          if (declaration.kinds.has("behavior")) {
            return printBehavior(declaration);
          }
          if (declaration.kinds.has("element-mixin")) {
            return printMixin(declaration);
          }
          return "";
        }).join("");
        return `\ndeclare module "${path}" {${moduleContents}\n}`;
      })
      .join("\n");
    if (types.length) {
      fs.writeFileSync(cli.outFile, types.trim().concat("\n"));
    }
  })
  .then(() => {
    console.log("done");
    process.exit(0);
  })
  .catch(err => {
    console.log(err);
    process.exit(-1);
  });
