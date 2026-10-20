import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "src-tauri/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: [
            ["@babel/preset-env", { targets: { esmodules: true } }],
            ["@babel/preset-react", { runtime: "automatic" }],
            ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
          ],
        },
        sourceType: "module",
      },
      globals: globals.browser,
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
];
