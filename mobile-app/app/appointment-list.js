import React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
// Import your EXISTING component
import AppointmentList from '../components/AppointmentList'; 

export default function AppointmentListRoute() {
  const params = useLocalSearchParams();

  return (
    <>
      <Stack.Screen options={{ title: 'My Visits' }} />
      
      <AppointmentList role={params.role} userId={params.userId} authToken={params.authToken} />
    </>
  );
}
