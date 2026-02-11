import { Platform } from 'react-native';

// Android Emulator cannot see "localhost", it sees the host computer as 10.0.2.2
// iOS Simulator sees "localhost" correctly.
const LOCAL_SERVER = Platform.OS === 'android' 
  ? 'http://10.0.2.2:3000' 
  : 'http://localhost:3000';

// If we are in development mode, use local. In production, use real URL.
export const API_BASE_URL = __DEV__ ? LOCAL_SERVER : 'https://api.aloha-readiness.com';