import React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import CaregiverSchedulerSupport from '../components/CaregiverSchedulerSupport';

export default function SchedulerSupportRoute() {
  const params = useLocalSearchParams();

  return (
    <>
      <Stack.Screen options={{ title: 'Scheduler Support' }} />
      <CaregiverSchedulerSupport role={params.role} userId={params.userId} authToken={params.authToken} />
    </>
  );
}
