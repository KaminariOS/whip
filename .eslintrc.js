module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        'no-void': ['warn', { allowAsStatement: true }],
      },
    },
  ],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.',
      },
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.',
      },
    ],
  },
};
