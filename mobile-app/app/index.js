import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons'; // Ensure you have this or use simple text

export default function RoleSelectionScreen() {
  const router = useRouter();


  const handleLogin = (role) => {
    // 1. Define Mock Users for the Demo
    let userData = {};
    
    if (role === 'CAREGIVER') {
      userData = { 
        userId: '00000000-0000-0000-0000-000000000002', 
        name: 'Bob Caregiver',
        role: 'CAREGIVER' 
      };
      
      // Navigate to the Dashboard for Caregivers/Patients
      router.push({ pathname: '/dashboard', params: userData });
    } 
    else if (role === 'FAMILY') { // "Patient" role
      userData = { userId: '00000000-0000-0000-0000-000000000001', name: 'Alice Family', role: 'FAMILY' };
      router.push({ pathname: '/dashboard', params: userData });
    } 
    else if (role === 'COORDINATOR') { // "Scheduler" role
      // Scheduler goes straight to the master list
      userData = { userId: '00000000-0000-0000-0000-000000000004', name: 'Scheduler', role: 'COORDINATOR' };
      router.push({ pathname: '/appointment-list', params: userData });
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Select Your Role</Text>
      <Text style={styles.subHeader}>Healthcare Platform Demo</Text>

      <TouchableOpacity style={styles.card} onPress={() => handleLogin('CAREGIVER')}>
        <View style={[styles.iconBox, { backgroundColor: '#E3F2FD' }]}>
          <Ionicons name="medkit" size={32} color="#2196F3" />
        </View>
        <View>
          <Text style={styles.roleTitle}>Caregiver</Text>
          <Text style={styles.roleDesc}>Log timesheets & chat</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.card} onPress={() => handleLogin('FAMILY')}>
        <View style={[styles.iconBox, { backgroundColor: '#E8F5E9' }]}>
          <Ionicons name="person" size={32} color="#4CAF50" />
        </View>
        <View>
          <Text style={styles.roleTitle}>Patient / Family</Text>
          <Text style={styles.roleDesc}>View care plan & chat</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.card} onPress={() => handleLogin('COORDINATOR')}>
        <View style={[styles.iconBox, { backgroundColor: '#FFF3E0' }]}>
          <Ionicons name="calendar" size={32} color="#FF9800" />
        </View>
        <View>
          <Text style={styles.roleTitle}>Scheduler</Text>
          <Text style={styles.roleDesc}>Manage appointments & readiness</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: 'center', backgroundColor: '#fff' },
  header: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: 10 },
  subHeader: { fontSize: 16, color: '#666', textAlign: 'center', marginBottom: 40 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#eee',
    elevation: 2, // Shadow for Android
    shadowColor: '#000', // Shadow for iOS
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  iconBox: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center', marginRight: 20 },
  roleTitle: { fontSize: 20, fontWeight: 'bold' },
  roleDesc: { color: '#666', marginTop: 4 },
});