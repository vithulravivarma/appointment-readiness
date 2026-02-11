import React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
// Import your EXISTING component
import AppointmentList from '../components/AppointmentList'; 

export default function AppointmentListRoute() {
  // 1. Get the params from the URL (e.g. ?role=CAREGIVER)
  const params = useLocalSearchParams();

  return (
    <>
      <Stack.Screen options={{ title: 'My Visits' }} />
      
      {/* 2. Render your component and pass the params down */}
      <AppointmentList role={params.role} userId={params.userId} />
    </>
  );
}