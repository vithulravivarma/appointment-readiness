import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { Link, Stack } from 'expo-router';


export default function AppointmentDetail({ appointmentId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (appointmentId) fetchDetails();
  }, [appointmentId]);

  const fetchDetails = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/appointments/${appointmentId}/readiness`);
      setData(response.data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <View style={styles.container}><Text>Loading details...</Text></View>;
  if (!data) return <View style={styles.container}><Text>Error loading data</Text></View>;

  return (
    <View style={styles.container}>
      {/* If testing, Stack might not exist, so we check for it or ignore it */}
      {Stack?.Screen && <Stack.Screen options={{ title: 'Readiness Details' }} />}

      <Text style={styles.header}>Status: {data.summary.status}</Text>
      
      <Text style={styles.sectionTitle}>Checklist</Text>
      
      <ScrollView>
        {data.checklist.map((item, index) => (
          <View key={index} style={styles.checkItem}>
            <Text style={styles.checkTitle}>{item.check_type}</Text>
            <View style={[
              styles.badge, 
              item.status === 'PASS' ? styles.badgePass : styles.badgePending
            ]}>
              <Text style={styles.badgeText}>{item.status}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Link href={`/chat/${appointmentId}`} asChild>
          <TouchableOpacity style={styles.chatButton}>
            <Text style={styles.chatButtonText}>Message Coordinator</Text>
          </TouchableOpacity>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  header: { fontSize: 22, fontWeight: 'bold', marginBottom: 20 },
  sectionTitle: { fontSize: 18, color: '#666', marginBottom: 10 },
  checkItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#eee'
  },
  checkTitle: { fontSize: 16 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 15 },
  badgePass: { backgroundColor: '#d4edda' },
  badgePending: { backgroundColor: '#fff3cd' },
  badgeText: { fontWeight: 'bold', fontSize: 12 },
  footer: {
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    marginTop: 10,
  },
  chatButton: {
    backgroundColor: '#34C759', // iOS Green
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  chatButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  }
});