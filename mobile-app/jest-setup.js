// 1. Mock standard libraries
jest.mock('expo-constants', () => ({
  manifest: { extra: {} },
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn(),
}));

// 2. Mock Axios
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

// 3. AGGRESSIVE MOCK for Expo Router
// This fixes the "TypeError: match" error by preventing the real library from loading.
jest.mock('expo-router', () => ({
  // The Link component just renders its children
  Link: ({ children }) => children,
  // The hook returns a dummy ID
  useLocalSearchParams: jest.fn(() => ({ id: '123' })),
  // Stack just renders nothing or children during tests
  Stack: {
    Screen: () => null
  }
}));