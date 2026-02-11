import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function Dashboard() {
  const router = useRouter();
  const params = useLocalSearchParams(); // Gets { role, name, userId } passed from index

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>Welcome, {params.name}</Text>
      <Text style={styles.roleTag}>{params.role}</Text>

      <View style={styles.grid}>
        {/* BOX 1: TIMESHEETS (Placeholder) */}
        <TouchableOpacity style={styles.box} onPress={() => alert('Timesheets Feature Coming Soon')}>
          <Ionicons name="time" size={40} color="#666" />
          <Text style={styles.boxText}>Timesheets</Text>
        </TouchableOpacity>

        {/* BOX 2: CHAT / APPOINTMENTS */}
        <TouchableOpacity 
          style={[styles.box, styles.activeBox]} 
          onPress={() => {
            // Navigate to the list, but pass the USER CONTEXT along
            router.push({ 
              pathname: '/appointment-list', 
              params: { ...params } // Pass role/userId forward
            });
          }}
        >
          <Ionicons name="chatbubbles" size={40} color="#fff" />
          <Text style={[styles.boxText, { color: '#fff' }]}>My Chats</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff', paddingTop: 60 },
  welcome: { fontSize: 24, fontWeight: 'bold' },
  roleTag: { 
    alignSelf: 'flex-start', 
    backgroundColor: '#eee', 
    paddingHorizontal: 10, 
    paddingVertical: 4, 
    borderRadius: 8, 
    marginTop: 5, 
    fontSize: 12, 
    fontWeight: 'bold', 
    color: '#555' 
  },
  grid: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 40 },
  box: {
    width: '48%',
    height: 150,
    backgroundColor: '#f5f5f5',
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd'
  },
  activeBox: {
    backgroundColor: '#2196F3', // Blue for the active feature
    borderColor: '#2196F3'
  },
  boxText: { marginTop: 10, fontSize: 16, fontWeight: '600' }
});