module.exports = {
    preset: 'jest-expo',
    rootDir: '.', // 1. Explicitly set root to mobile-app folder
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|axios|expo-router)'
    ],

    setupFiles: ['<rootDir>/jest-setup.js'],

    setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
    // 2. Mock out the specific internal modules causing the "Winter" runtime error
    moduleNameMapper: {
        '^expo-router$': '<rootDir>/node_modules/expo-router/entry',
        '.*expo/src/winter/.*': '<rootDir>/jest-setup.js',
    }
};