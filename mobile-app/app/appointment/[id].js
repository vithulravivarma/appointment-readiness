import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import AppointmentDetail from '../../components/AppointmentDetail';

export default function AppointmentDetailPage() {
  const { id } = useLocalSearchParams();
  return <AppointmentDetail appointmentId={id} />;
}