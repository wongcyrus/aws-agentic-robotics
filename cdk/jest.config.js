module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'bin/**/*.ts',
    'lib/**/*.ts',
    '!lib/**/function/**/*.ts',
    '!**/*.d.ts'
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
