import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { Stack, useRouter } from 'expo-router';
import { DS, baseStyles } from '../design/system';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function AppointmentDetail({ appointmentId, authToken }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if (appointmentId) {
      fetchDetails();
    }
  }, [appointmentId]);

  const fetchDetails = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/appointments/${appointmentId}/readiness`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      setData(response.data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading readiness details...</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Unable to load readiness data.</Text>
      </View>
    );
  }

  const statusTone = data.status === 'READY' ? styles.statusReady : styles.statusRisk;

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
      <View style={styles.container}>
        {Stack?.Screen && <Stack.Screen options={{ title: 'Readiness Details' }} />}

        <View style={styles.headerCard}>
          <Text style={styles.headerTitle}>Appointment Status</Text>
          <Text style={[styles.statusPill, statusTone]}>{data.status}</Text>
        </View>

        <Text style={styles.sectionTitle}>Checklist</Text>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {data.checks.map((item, index) => (
            <View key={`${item.check_type}-${index}`} style={styles.checkItem}>
              <Text style={styles.checkTitle}>{item.check_type}</Text>
              <View style={[styles.badge, item.status === 'PASS' ? styles.badgePass : styles.badgePending]}>
                <Text style={styles.badgeText}>{item.status}</Text>
              </View>
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.chatButton}
            onPress={() => {
              router.push({
                pathname: `/chat/${appointmentId}`,
                params: { role: 'COORDINATOR', userId: '00000000-0000-0000-0000-000000000004', authToken },
              });
            }}
          >
            <Text style={styles.chatButtonText}>Enter Chat Room</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    ...baseStyles.screen,
  },
  container: {
    ...baseStyles.screen,
    paddingHorizontal: DS.spacing.md,
    paddingTop: DS.spacing.md,
  },
  loadingText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.body,
  },
  headerCard: {
    ...baseStyles.card,
    padding: DS.spacing.md,
    marginBottom: DS.spacing.md,
  },
  headerTitle: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    borderRadius: DS.radius.pill,
    fontWeight: '700',
  },
  statusReady: {
    color: DS.colors.success,
    backgroundColor: '#E7F5EC',
  },
  statusRisk: {
    color: DS.colors.warning,
    backgroundColor: '#FBF0DF',
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginBottom: DS.spacing.xs,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: DS.spacing.md,
  },
  checkItem: {
    ...baseStyles.card,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    marginBottom: DS.spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  checkTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
  },
  badgePass: {
    backgroundColor: '#E7F5EC',
  },
  badgePending: {
    backgroundColor: '#FBF0DF',
  },
  badgeText: {
    color: DS.colors.textPrimary,
    fontWeight: '700',
    fontSize: DS.typography.micro,
  },
  footer: {
    paddingTop: DS.spacing.sm,
    paddingBottom: DS.spacing.md,
  },
  chatButton: {
    backgroundColor: DS.colors.brand,
    paddingVertical: DS.spacing.sm,
    borderRadius: DS.radius.md,
    alignItems: 'center',
  },
  chatButtonText: {
    color: DS.colors.surface,
    fontSize: DS.typography.body,
    fontWeight: '700',
  },
});
