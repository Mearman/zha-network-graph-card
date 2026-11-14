import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  ...tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
);
