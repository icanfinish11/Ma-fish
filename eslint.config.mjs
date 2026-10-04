import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/src/generated/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // C9 / 威胁 #11：禁止非参数化 raw SQL
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: '$queryRawUnsafe 被禁止（威胁 #11）。请使用参数化 Prisma API 或 $queryRaw 模板标签。',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: '$executeRawUnsafe 被禁止（威胁 #11）。',
        },
      ],
      // C9 / 威胁 #9：禁止裸 HTML 注入
      'no-restricted-properties': [
        'error',
        { object: 'React', property: 'dangerouslySetInnerHTML', message: 'XSS 风险（威胁 #9）。必须走白名单 sanitizer。' },
      ],
      // C2：平台绝不执行用户代码
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
);
