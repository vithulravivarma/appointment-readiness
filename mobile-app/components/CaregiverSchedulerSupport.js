import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import axios from 'axios';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { API_BASE_URL } from '../constants/Config';
import { DS, baseStyles } from '../design/system';

const CRITICAL_CHECKS = new Set(['ACCESS_CONFIRMED', 'MEDS_SUPPLIES_READY', 'CARE_PLAN_CURRENT']);

function getApiError(error, fallback) {
  const message = String(error?.response?.data?.error || error?.message || '').trim();
  return message || fallback;
}

export default function CaregiverSchedulerSupport({ userId, role, authToken }) {
  const router = useRouter();
  const normalizedRole = String(role || '').toUpperCase();
  const caregiverId = String(userId || '').trim();

  const [threadMessages, setThreadMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [composer, setComposer] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);

  const [escalations, setEscalations] = useState([]);
  const [escalationsLoading, setEscalationsLoading] = useState(true);
  const [selectedEscalationId, setSelectedEscalationId] = useState('');
  const [readinessByAppointment, setReadinessByAppointment] = useState({});

  const [notice, setNotice] = useState('');

  const headers = useMemo(
    () => (authToken ? { Authorization: `Bearer ${authToken}` } : undefined),
    [authToken],
  );

  const selectedEscalation = useMemo(
    () => escalations.find((item) => item.id === selectedEscalationId) || null,
    [escalations, selectedEscalationId],
  );

  const selectedReadiness = selectedEscalation?.appointmentId
    ? readinessByAppointment[selectedEscalation.appointmentId]
    : null;

  const visibleMessages = useMemo(() => {
    return [...threadMessages].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }, [threadMessages]);

  const loadThreadMessages = useCallback(async () => {
    if (!caregiverId) {
      setThreadMessages([]);
      return;
    }
    try {
      setMessagesLoading(true);
      const response = await axios.get(`${API_BASE_URL}/scheduler/threads/${caregiverId}/messages`, {
        params: { limit: 160 },
        headers,
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      setThreadMessages(rows);
    } catch (error) {
      console.error('Failed to load caregiver scheduler thread', error);
      const message = getApiError(error, 'Unable to load scheduler support messages.');
      setNotice(message);
      Alert.alert('Error', message);
    } finally {
      setMessagesLoading(false);
    }
  }, [caregiverId, headers]);

  const loadEscalations = useCallback(async () => {
    if (!caregiverId) {
      setEscalations([]);
      return;
    }
    try {
      setEscalationsLoading(true);
      const response = await axios.get(`${API_BASE_URL}/escalations`, {
        params: {
          caregiverId,
          limit: 120,
        },
        headers,
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      setEscalations(rows);
      if (!rows.length) {
        setSelectedEscalationId('');
        return;
      }
      const exists = rows.some((item) => item.id === selectedEscalationId);
      if (!exists) {
        const preferred = rows.find((item) => ['OPEN', 'ACKNOWLEDGED', 'ACTION_REQUESTED'].includes(item.status)) || rows[0];
        setSelectedEscalationId(preferred.id);
      }
    } catch (error) {
      console.error('Failed to load caregiver escalations', error);
      const message = getApiError(error, 'Unable to load escalations.');
      setNotice(message);
      Alert.alert('Error', message);
    } finally {
      setEscalationsLoading(false);
    }
  }, [caregiverId, headers, selectedEscalationId]);

  const loadReadinessForAppointment = useCallback(
    async (appointmentId) => {
      const normalizedId = String(appointmentId || '').trim();
      if (!normalizedId || readinessByAppointment[normalizedId]) return;
      try {
        const response = await axios.get(`${API_BASE_URL}/appointments/${normalizedId}/readiness`, {
          headers,
        });
        setReadinessByAppointment((prev) => ({
          ...prev,
          [normalizedId]: response.data,
        }));
      } catch (error) {
        console.error('Failed to load caregiver readiness detail', error);
      }
    },
    [headers, readinessByAppointment],
  );

  useEffect(() => {
    if (normalizedRole !== 'CAREGIVER') return;
    loadThreadMessages();
    loadEscalations();
  }, [loadEscalations, loadThreadMessages, normalizedRole]);

  useEffect(() => {
    if (!selectedEscalation?.appointmentId) return;
    loadReadinessForAppointment(selectedEscalation.appointmentId);
  }, [loadReadinessForAppointment, selectedEscalation]);

  useEffect(() => {
    if (normalizedRole !== 'CAREGIVER') return undefined;
    const interval = setInterval(() => {
      loadThreadMessages();
      loadEscalations();
    }, 6000);
    return () => clearInterval(interval);
  }, [loadEscalations, loadThreadMessages, normalizedRole]);

  useEffect(() => {
    setNotice('');
  }, [selectedEscalationId]);

  const postMessage = async () => {
    const text = composer.trim();
    if (!text) {
      setNotice('Enter a message for scheduler support.');
      return;
    }
    if (!caregiverId) {
      setNotice('Missing caregiver identity for scheduler support.');
      return;
    }

    try {
      setSendingMessage(true);
      await axios.post(
        `${API_BASE_URL}/scheduler/threads/${caregiverId}/messages`,
        {
          content: text,
          escalationId: selectedEscalation?.id,
        },
        { headers },
      );
      setComposer('');
      await Promise.all([loadThreadMessages(), loadEscalations()]);
      setNotice('Message sent to scheduler support.');
    } catch (error) {
      console.error('Failed to send caregiver scheduler message', error);
      const message = getApiError(error, 'Unable to send scheduler support message.');
      setNotice(message);
      Alert.alert('Error', message);
    } finally {
      setSendingMessage(false);
    }
  };

  const openAppointmentChat = () => {
    if (!selectedEscalation?.appointmentId) {
      setNotice('This escalation has no appointment chat linked.');
      return;
    }
    router.push({
      pathname: `/chat/${selectedEscalation.appointmentId}`,
      params: {
        role: normalizedRole,
        userId: caregiverId,
        authToken,
      },
    });
  };

  if (normalizedRole !== 'CAREGIVER') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.deniedWrap}>
          <Text style={styles.deniedTitle}>Caregiver access required</Text>
          <Text style={styles.deniedText}>This screen is only available for caregiver accounts.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerCard}>
          <Text style={styles.title}>Scheduler Support</Text>
          <Text style={styles.subtitle}>Talk directly with scheduler team and track escalations tied to your visits.</Text>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Support Chat</Text>
            {messagesLoading ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>

          {visibleMessages.length === 0 ? (
            <Text style={styles.emptyText}>No messages yet.</Text>
          ) : (
            <View style={styles.messageFeed}>
              {visibleMessages.map((message) => {
                const senderType = String(message.senderType || '').toUpperCase();
                const mine = senderType === 'CAREGIVER';
                const system = senderType === 'SYSTEM';
                const linked = message.escalationId
                  ? escalations.find((item) => item.id === message.escalationId)
                  : null;

                return (
                  <TouchableOpacity
                    key={message.id}
                    style={[styles.messageCard, mine && styles.messageCardMine, system && styles.messageCardSystem]}
                    activeOpacity={linked ? 0.75 : 1}
                    onPress={() => {
                      if (linked?.id) setSelectedEscalationId(linked.id);
                    }}
                  >
                    <View style={styles.messageTop}>
                      <Text style={styles.messageSender}>{senderType}</Text>
                      <Text style={styles.messageTime}>{formatTimeStamp(message.createdAt)}</Text>
                    </View>
                    <Text style={[styles.messageText, mine && styles.messageTextMine]}>{message.content}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <View style={styles.composerWrap}>
            <TextInput
              style={styles.composerInput}
              value={composer}
              onChangeText={setComposer}
              placeholder="Message scheduler support"
              placeholderTextColor={DS.colors.textMuted}
              multiline
            />
            <TouchableOpacity
              style={[styles.primaryButton, sendingMessage && styles.primaryButtonDisabled]}
              onPress={postMessage}
              disabled={sendingMessage}
            >
              <Text style={styles.primaryButtonText}>{sendingMessage ? 'Sending...' : 'Send'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Escalations</Text>
            {escalationsLoading ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>
          {escalations.length === 0 ? <Text style={styles.emptyText}>No escalations yet.</Text> : null}

          {escalations.map((item) => {
            const active = item.id === selectedEscalationId;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.escalationCard, active && styles.escalationCardActive]}
                onPress={() => setSelectedEscalationId(item.id)}
              >
                <Text style={styles.escalationSummary}>{item.summary}</Text>
                <View style={styles.statusRow}>
                  <Text style={styles.statusChip}>{item.status}</Text>
                  <Text style={styles.categoryChip}>{item.category}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Escalation Context</Text>
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}

          {!selectedEscalation ? (
            <Text style={styles.emptyText}>Select an escalation to inspect details.</Text>
          ) : (
            <>
              <Text style={styles.contextSummary}>{selectedEscalation.summary}</Text>
              <View style={styles.statusRow}>
                <Text style={styles.statusChip}>{selectedEscalation.status}</Text>
                <Text style={styles.categoryChip}>{selectedEscalation.category}</Text>
              </View>
              <Text style={styles.contextMeta}>Opened {formatTimeStamp(selectedEscalation.openedAt)}</Text>

              <TouchableOpacity
                style={[styles.primaryButtonWide, !selectedEscalation.appointmentId && styles.primaryButtonWideDisabled]}
                onPress={openAppointmentChat}
                disabled={!selectedEscalation.appointmentId}
              >
                <Text style={styles.primaryButtonText}>
                  {selectedEscalation.appointmentId ? 'Open Appointment Chat' : 'No Appointment Linked'}
                </Text>
              </TouchableOpacity>

              <Text style={styles.subsectionTitle}>Appointment Readiness (Critical)</Text>
              {selectedEscalation.appointmentId ? (
                selectedReadiness ? (
                  selectedReadiness.checks
                    .filter((check) => CRITICAL_CHECKS.has(String(check.check_type || '').toUpperCase()))
                    .map((check) => (
                      <View key={check.check_type} style={styles.readinessCard}>
                        <View style={styles.readinessHeader}>
                          <Text style={styles.readinessCheckName}>{check.check_type}</Text>
                          <Text style={styles.readinessCheckStatus}>{check.status}</Text>
                        </View>
                        <Text style={styles.readinessDesc}>{check.description}</Text>
                      </View>
                    ))
                ) : (
                  <Text style={styles.emptyText}>Loading readiness checks...</Text>
                )
              ) : (
                <Text style={styles.emptyText}>This escalation does not reference a specific appointment.</Text>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function formatTimeStamp(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

const styles = StyleSheet.create({
  safeArea: {
    ...baseStyles.screen,
  },
  content: {
    paddingHorizontal: DS.spacing.md,
    paddingBottom: DS.spacing.xl,
  },
  headerCard: {
    ...baseStyles.card,
    marginTop: DS.spacing.sm,
    marginBottom: DS.spacing.sm,
    padding: DS.spacing.md,
    gap: DS.spacing.xxs,
  },
  title: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.title,
    fontWeight: '800',
  },
  subtitle: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  sectionCard: {
    ...baseStyles.card,
    marginBottom: DS.spacing.sm,
    padding: DS.spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DS.spacing.xs,
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  messageCard: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.md,
    backgroundColor: DS.colors.surface,
    padding: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
    maxWidth: '88%',
    alignSelf: 'flex-start',
  },
  messageCardMine: {
    borderColor: '#BCDCD6',
    backgroundColor: '#ECF6F4',
    alignSelf: 'flex-end',
  },
  messageCardSystem: {
    borderColor: '#D4DDE8',
    backgroundColor: '#F3F6FA',
    alignSelf: 'flex-start',
    maxWidth: '96%',
  },
  messageFeed: {
    marginTop: DS.spacing.xs,
    gap: DS.spacing.xs,
  },
  messageTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  messageSender: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.micro,
    fontWeight: '800',
  },
  messageTime: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
  },
  messageText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  messageTextMine: {
    color: DS.colors.brandStrong,
  },
  composerWrap: {
    marginTop: DS.spacing.sm,
    gap: DS.spacing.xs,
  },
  composerInput: {
    minHeight: 76,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    color: DS.colors.textPrimary,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
    textAlignVertical: 'top',
  },
  primaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: DS.colors.brand,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.xs,
  },
  primaryButtonDisabled: {
    backgroundColor: '#9AB5B2',
  },
  primaryButtonWide: {
    marginTop: DS.spacing.sm,
    alignItems: 'center',
    backgroundColor: DS.colors.brand,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
  },
  primaryButtonWideDisabled: {
    backgroundColor: '#9AB5B2',
  },
  primaryButtonText: {
    color: DS.colors.surface,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  escalationCard: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    padding: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
  },
  escalationCardActive: {
    borderColor: DS.colors.brand,
    backgroundColor: '#EAF5F3',
  },
  escalationSummary: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DS.spacing.xs,
    marginTop: DS.spacing.xs,
  },
  statusChip: {
    color: DS.colors.brandStrong,
    backgroundColor: '#DFF3EF',
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
    overflow: 'hidden',
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  categoryChip: {
    color: DS.colors.warning,
    backgroundColor: '#FBF0DF',
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
    overflow: 'hidden',
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  contextSummary: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    lineHeight: 22,
  },
  contextMeta: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: DS.spacing.xs,
  },
  subsectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
    marginTop: DS.spacing.md,
    marginBottom: DS.spacing.xs,
  },
  readinessCard: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    padding: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
    backgroundColor: DS.colors.surface,
  },
  readinessHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: DS.spacing.xs,
    marginBottom: DS.spacing.xxs,
  },
  readinessCheckName: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  readinessCheckStatus: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    fontWeight: '800',
  },
  readinessDesc: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    lineHeight: 16,
  },
  noticeText: {
    marginTop: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
    color: DS.colors.info,
    fontSize: DS.typography.micro,
    lineHeight: 16,
    fontWeight: '600',
  },
  emptyText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xs,
  },
  deniedWrap: {
    ...baseStyles.card,
    margin: DS.spacing.md,
    padding: DS.spacing.md,
    gap: DS.spacing.xs,
  },
  deniedTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
  },
  deniedText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
});
