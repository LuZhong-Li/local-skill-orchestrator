import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: ['**/build/**', '**/out/**', '**/node_modules/**', 'docs/**', 'gui/packaging/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 只用 Vue 的正确性规则：模板格式交给 Prettier，两套格式化规则并行会互相打架
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // 组件名由界面结构决定，不强制多词命名
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // 渲染层是纯视图：数据源只有内核输出，不得接触 Node 与 Electron 运行时
    files: ['gui/renderer/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['node:*', 'fs', 'path', 'os', 'child_process', 'electron'],
        },
      ],
    },
  },
);
