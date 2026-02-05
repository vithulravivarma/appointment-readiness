import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import AppointmentList from '../components/AppointmentList';

export default function Home() {
  return (
    <View style={styles.container}>
      {/* 1. Set the Title Bar text */}
      <Stack.Screen options={{ title: 'My Appointments' }} />

      {/* 2. Show the List Component */}
      <AppointmentList />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});