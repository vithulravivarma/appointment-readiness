import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import AppointmentList from './AppointmentList';
import axios from 'axios';

// 1. Mock Axios so we don't actually hit the server during tests
// jest.mock('axios');

describe('AppointmentList', () => {
    test('fetches and displays appointments', async () => {
        // 2. Setup the mock response (what the API *should* return)
        const mockAppointments = [
            {
                id: '123',
                client_name: 'Alice Family',
                readiness_status: 'READY',
                start_time: '2023-10-27T10:00:00Z',
                service_type: 'ABA Therapy'
            }
        ];

        axios.get.mockResolvedValue({ data: { data: mockAppointments } });

        // 3. Render the component
        render(<AppointmentList />);

        // 4. Expect to see "Loading..." initially
        expect(screen.getByText('Loading...')).toBeTruthy();

        // 5. Wait for the data to load and appear
        await waitFor(() => {
            expect(screen.getByText('Alice Family')).toBeTruthy();
            expect(screen.getByText('Status: READY')).toBeTruthy();
        });
    });
});