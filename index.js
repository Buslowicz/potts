"use strict";

const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const commandLineArgs = require("command-line-args");
const commandLineUsage = require("command-line-usage");
const Analyzer = require("polymer-analyzer").Analyzer;
const FSUrlLoader = require("polymer-analyzer/lib/url-loader/fs-url-loader").FSUrlLoader;
const PackageUrlResolver = require("polymer-analyzer/lib/url-loader/package-url-resolver").PackageUrlResolver;

let analyzer = new Analyzer({
  urlLoader: new FSUrlLoader(process.cwd()),
  urlResolver: new PackageUrlResolver()
});

const indent = tab => line => line.length > 0 ? tab + line : line;
const filterFeatures = item => item.constructor.name === "PolymerElement" || item.constructor.name === "Behavior";
const jsDoc = (desc, indentLevel = 0) => {
  if (!desc || !desc.length) {
    return "";
  }

  if (!Array.isArray(desc)) {
    desc = desc.split("\n");
  }
  let tab = "  ".repeat(indentLevel);
  return [
    "/**",
    ...desc.map(line => ` * ${line}`),
    " */",
    ""
  ].map(indent(tab)).join("\n");
};
const cast = (type, params) => {
  let primitives = [ "string", "number", "boolean" ];
  if (primitives.includes(type)) {
    return type;
  }
  if (type === "Function") {
    return `(${(params || []).map(param => `${param.name}: any`).join(", ")}) => any`;
  }
  if (type === "Array") {
    return "Array<any>";
  } else {
    return "any";
  }
};
const NS = ns => (tpl) => {
  if (!ns) {
    return tpl;
  }
  return [
    `declare namespace ${ns} {`,
    tpl.split("\n").map(indent("  ")).join("\n"),
    "}",
    ""
  ].join("\n");
};

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
    defaultValue: ""
  },
  {
    name: "output",
    alias: "o",
    type: String,
    description: "Output all declarations to single file",
//    defaultValue: "index.d.ts"
  },
  {
    name: "input",
    type: String,
    multiple: false,
    defaultOption: true
  }
];

let cli;

try {
  cli = commandLineArgs(cliOptions);
} catch (e) {
  console.error(e.message);
  process.exit(-1);
}
if (cli.help) {
  const packageJSON = require("./package.json");
  const execName = Object.keys(packageJSON.bin)[0];
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

analyzer.analyze(cli.input)
  .then((document) => Array
    .from(document.getFeatures())
    .filter(filterFeatures)
    .map(item => {
      let cNameParts = item.className && item.className.split(".");
      let [ namespace, name ] = item.tagName ?
        [ null, item.tagName ] : [ cNameParts[ 0 ], cNameParts.slice(-1)[ 0 ] ];
      let declaration = namespace ? "export" : "declare";
      let camelName = name.replace(/(?:^|-)(.)/g, (_, m) => m.toUpperCase());
      return {
        namespace, name,
        dts: NS(namespace)(`${jsDoc(item.description)}${declaration} interface ${camelName} {\n${
          item.properties
            .map(({ name, type, readOnly, params, description }) => {
              return `${jsDoc(description, 1)}  ${readOnly ? "readonly " : ""}${name}: ${cast(type, params)};`;
            })
            .concat([ `  new (): ${camelName};` ])
            .join("\n")
          }\n}`)
      };
    }))
  .then(elements => {
    if (cli.output) {
      let dts = elements.map(el => el.dts).join("\n");
      return new Promise((done, fail) => fs.writeFile(cli.output, dts, (err) => err ? fail(err) : done()));
    } else {
      if (cli.outDir && !fs.existsSync(cli.outDir)) {
        fs.mkdirSync(cli.outDir);
      }
      return Promise.all(elements.map(el => {
        return new Promise((done, fail) => {
          return fs.writeFile(path.join(cli.outDir, `${el.name}.d.ts`), el.dts, (err) => err ? fail(err) : done());
        });
      }));
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
