import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { DS, baseStyles } from '../design/system';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Dashboard() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { width } = useWindowDimensions();
  const compact = width < 390;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerPanel}>
          <Text style={styles.welcome}>Welcome, {params.name}</Text>
          <Text style={styles.roleTag}>{params.role}</Text>
        </View>

        <View style={[styles.grid, compact && styles.gridCompact]}>
          <TouchableOpacity style={[styles.box, compact && styles.boxCompact]} onPress={() => alert('Timesheets Feature Coming Soon')}>
            <View style={[styles.iconBadge, { backgroundColor: '#E6EEF7' }]}>
              <Ionicons name="time" size={28} color={DS.colors.info} />
            </View>
            <Text style={styles.boxTitle}>Timesheets</Text>
            <Text style={styles.boxMeta}>Track hours and approvals</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.box, styles.activeBox, compact && styles.boxCompact]}
            onPress={() => {
              router.push({
                pathname: '/appointment-list',
                params: { ...params },
              });
            }}
          >
            <View style={[styles.iconBadge, styles.activeIconBadge]}>
              <Ionicons name="chatbubbles" size={28} color={DS.colors.surface} />
            </View>
            <Text style={styles.activeBoxTitle}>My Chats</Text>
            <Text style={styles.activeBoxMeta}>Live appointment communication</Text>
          </TouchableOpacity>
        </View>

        {params.role === 'CAREGIVER' && (
          <>
            <TouchableOpacity
              style={styles.agentDeskButton}
              onPress={() => {
                router.push({
                  pathname: '/agent-command-center',
                  params: { ...params },
                });
              }}
            >
              <Text style={styles.agentDeskTitle}>Agent Desk</Text>
              <Text style={styles.agentDeskMeta}>
                Delegate conversations, assign goals, and review AI summaries when you return.
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.schedulerSupportButton}
              onPress={() => {
                router.push({
                  pathname: '/scheduler-support',
                  params: { ...params },
                });
              }}
            >
              <Text style={styles.schedulerSupportTitle}>Scheduler Support</Text>
              <Text style={styles.schedulerSupportMeta}>
                Message scheduler directly and track escalation updates in one thread.
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    ...baseStyles.screen,
  },
  container: {
    paddingHorizontal: DS.spacing.md,
    paddingTop: DS.spacing.xl,
    paddingBottom: DS.spacing.xl,
  },
  headerPanel: {
    ...baseStyles.card,
    padding: DS.spacing.md,
    marginBottom: DS.spacing.lg,
  },
  welcome: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.title,
    fontWeight: '800',
    marginBottom: DS.spacing.xs,
  },
  roleTag: {
    alignSelf: 'flex-start',
    backgroundColor: '#DFF3EF',
    color: DS.colors.brandStrong,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    gap: DS.spacing.sm,
    flexWrap: 'wrap',
  },
  gridCompact: {
    flexDirection: 'column',
  },
  box: {
    ...baseStyles.card,
    flex: 1,
    minHeight: 190,
    minWidth: 150,
    padding: DS.spacing.md,
    justifyContent: 'space-between',
  },
  boxCompact: {
    minHeight: 160,
  },
  activeBox: {
    backgroundColor: DS.colors.brand,
    borderColor: DS.colors.brand,
  },
  iconBadge: {
    width: 46,
    height: 46,
    borderRadius: DS.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activeIconBadge: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  boxTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginTop: DS.spacing.md,
  },
  boxMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  activeBoxTitle: {
    color: DS.colors.surface,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginTop: DS.spacing.md,
  },
  activeBoxMeta: {
    color: '#D8F2EE',
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  agentDeskButton: {
    ...baseStyles.card,
    marginTop: DS.spacing.sm,
    padding: DS.spacing.md,
    backgroundColor: '#EAF4F2',
    borderColor: '#B7D8D3',
  },
  agentDeskTitle: {
    color: DS.colors.brandStrong,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginBottom: DS.spacing.xxs,
  },
  agentDeskMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  schedulerSupportButton: {
    ...baseStyles.card,
    marginTop: DS.spacing.sm,
    padding: DS.spacing.md,
    backgroundColor: '#F2F6FC',
    borderColor: '#C9D8F4',
  },
  schedulerSupportTitle: {
    color: '#1E4F9A',
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginBottom: DS.spacing.xxs,
  },
  schedulerSupportMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
});
