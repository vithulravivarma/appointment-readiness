import React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import SchedulerDesk from '../components/SchedulerDesk';

export default function SchedulerDeskRoute() {
  const params = useLocalSearchParams();

  return (
    <>
      <Stack.Screen options={{ title: 'Scheduler Desk' }} />
      <SchedulerDesk
        role={params.role}
        userId={params.userId}
        authToken={params.authToken}
        returnCaregiverId={params.returnCaregiverId}
        returnThreadId={params.returnThreadId}
        focusEscalationId={params.fromEscalationId}
      />
    </>
  );
}
