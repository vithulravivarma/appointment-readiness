import { Platform } from 'react-native';
import Constants from 'expo-constants';

function sanitizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getExpoHost() {
  const hostUri =
    Constants?.expoConfig?.hostUri ||
    Constants?.manifest2?.extra?.expoClient?.hostUri ||
    '';
  const host = String(hostUri).split(':')[0];
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return '';
  }
  return host;
}

function resolveLocalServer() {
  const explicit = sanitizeUrl(process.env.EXPO_PUBLIC_API_BASE_URL);
  if (explicit) {
    return explicit;
  }

  const platformSpecific = sanitizeUrl(
    Platform.OS === 'android'
      ? process.env.EXPO_PUBLIC_ANDROID_API_BASE_URL
      : process.env.EXPO_PUBLIC_IOS_API_BASE_URL,
  );
  if (platformSpecific) {
    return platformSpecific;
  }

  const apiPort = String(process.env.EXPO_PUBLIC_API_PORT || '3001').trim();
  if (Platform.OS === 'android') {
    // Android emulator cannot access localhost directly.
    return `http://10.0.2.2:${apiPort}`;
  }

  const expoHost = getExpoHost();
  if (expoHost) {
    return `http://${expoHost}:${apiPort}`;
  }

  return `http://localhost:${apiPort}`;
}

const PROD_SERVER = sanitizeUrl(process.env.EXPO_PUBLIC_PROD_API_BASE_URL) || 'https://api.aloha-readiness.com';

export const API_BASE_URL = __DEV__ ? resolveLocalServer() : PROD_SERVER;
