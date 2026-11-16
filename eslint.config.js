import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["node_modules/", "coverage/", "outputs/", "logs/"]),
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { eqeqeq: ["error", "always"] },
  },
);
