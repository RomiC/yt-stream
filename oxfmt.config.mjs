export default {
  arrowParens: 'always',
  bracketSpacing: true,
  printWidth: 120,
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'none',
  useTabs: false,
  sortPackageJson: false,
  ignorePatterns: ['dist', '**/*.md'],
  overrides: [{ files: ['**/*.{yml,yaml}'], options: { singleQuote: false } }]
};
