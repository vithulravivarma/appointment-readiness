import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import AppointmentDetail from './AppointmentDetail';
import axios from 'axios';

// Mock Axios
jest.mock('axios');

// Mock Expo Router's hook so we can pretend we are on appointment ID "123"
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '123' }),
  Stack: { Screen: () => null }, // Mock the header component
}));

describe('AppointmentDetail', () => {
  test('fetches and displays the checklist', async () => {
    // 1. Setup Mock Response (What GET /appointments/123/readiness returns)
    const mockData = {
      summary: { status: 'IN_PROGRESS', risk_score: 50 },
      checklist: [
        { check_type: 'ACCESS_CODE', status: 'PASS', details: { code: '1234' } },
        { check_type: 'MEDICATION', status: 'PENDING', details: {} }
      ]
    };
    
    axios.get.mockResolvedValue({ data: mockData });

    // 2. Render
    render(<AppointmentDetail appointmentId="123" />);

    // 3. Expect "Loading..."
    expect(screen.getByText('Loading details...')).toBeTruthy();

    // 4. Wait for data
    await waitFor(() => {
      // Check for the items
      expect(screen.getByText('Checklist')).toBeTruthy();
      expect(screen.getByText('ACCESS_CODE')).toBeTruthy();
      expect(screen.getByText('MEDICATION')).toBeTruthy();
      
      // Check for status
      expect(screen.getByText('PASS')).toBeTruthy();
    });
  });
});