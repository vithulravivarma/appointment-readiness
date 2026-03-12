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

export default function SchedulerDesk({
  userId,
  role,
  authToken,
  returnCaregiverId,
  returnThreadId,
  focusEscalationId,
}) {
  const router = useRouter();
  const normalizedRole = String(role || '').toUpperCase();
  const normalizedUserId = String(userId || '00000000-0000-0000-0000-000000000004');

  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [selectedCaregiverId, setSelectedCaregiverId] = useState(String(returnCaregiverId || '').trim());
  const requestedThreadId = String(returnThreadId || '').trim();

  const [threadMessages, setThreadMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composer, setComposer] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);

  const [escalations, setEscalations] = useState([]);
  const [escalationsLoading, setEscalationsLoading] = useState(false);
  const [selectedEscalationId, setSelectedEscalationId] = useState(String(focusEscalationId || '').trim());

  const [readinessByAppointment, setReadinessByAppointment] = useState({});
  const [delegationsByCaregiver, setDelegationsByCaregiver] = useState({});
  const [overrideReason, setOverrideReason] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const [statusUpdating, setStatusUpdating] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [updatingReadinessKey, setUpdatingReadinessKey] = useState('');

  const headers = useMemo(
    () => (authToken ? { Authorization: `Bearer ${authToken}` } : undefined),
    [authToken],
  );

  const selectedThread = useMemo(
    () => threads.find((item) => item.caregiverId === selectedCaregiverId) || null,
    [threads, selectedCaregiverId],
  );

  const selectedEscalation = useMemo(
    () => escalations.find((item) => item.id === selectedEscalationId) || null,
    [escalations, selectedEscalationId],
  );

  const selectedEscalationStatus = String(selectedEscalation?.status || '').toUpperCase();
  const canAcknowledge = selectedEscalationStatus === 'OPEN';
  const canResolve = ['OPEN', 'ACKNOWLEDGED', 'ACTION_REQUESTED'].includes(selectedEscalationStatus);
  const isClosedEscalation = ['RESOLVED', 'HANDOFF_TO_CAREGIVER', 'AUTO_CLOSED'].includes(selectedEscalationStatus);

  const selectedReadiness = selectedEscalation?.appointmentId
    ? readinessByAppointment[selectedEscalation.appointmentId]
    : null;

  const selectedDelegation = useMemo(() => {
    if (!selectedEscalation?.appointmentId || !selectedCaregiverId) return null;
    const entries = delegationsByCaregiver[selectedCaregiverId] || [];
    return entries.find((entry) => String(entry.appointmentId) === String(selectedEscalation.appointmentId)) || null;
  }, [delegationsByCaregiver, selectedCaregiverId, selectedEscalation]);

  const visibleMessages = useMemo(() => {
    return [...threadMessages].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }, [threadMessages]);

  const loadThreads = useCallback(async () => {
    try {
      setThreadsLoading(true);
      const response = await axios.get(`${API_BASE_URL}/scheduler/threads`, {
        params: { limit: 120 },
        headers,
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      setThreads(rows);

      if (!rows.length) {
        setSelectedCaregiverId('');
        return;
      }

      if (!selectedCaregiverId && requestedThreadId) {
        const fromThread = rows.find((item) => String(item.threadId || '').trim() === requestedThreadId);
        if (fromThread?.caregiverId) {
          setSelectedCaregiverId(fromThread.caregiverId);
          return;
        }
      }

      const exists = rows.some((item) => item.caregiverId === selectedCaregiverId);
      if (!exists) {
        setSelectedCaregiverId(rows[0].caregiverId);
      }
    } catch (error) {
      console.error('Failed to load scheduler threads', error);
      const message = getApiError(error, 'Unable to load scheduler threads.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setThreadsLoading(false);
    }
  }, [headers, requestedThreadId, selectedCaregiverId]);

  const loadThreadMessages = useCallback(async () => {
    if (!selectedCaregiverId) {
      setThreadMessages([]);
      return;
    }
    try {
      setMessagesLoading(true);
      const response = await axios.get(`${API_BASE_URL}/scheduler/threads/${selectedCaregiverId}/messages`, {
        params: { limit: 160 },
        headers,
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      setThreadMessages(rows);
    } catch (error) {
      console.error('Failed to load scheduler thread messages', error);
      const message = getApiError(error, 'Unable to load scheduler messages.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setMessagesLoading(false);
    }
  }, [headers, selectedCaregiverId]);

  const loadEscalations = useCallback(async () => {
    if (!selectedCaregiverId) {
      setEscalations([]);
      return;
    }
    try {
      setEscalationsLoading(true);
      const response = await axios.get(`${API_BASE_URL}/escalations`, {
        params: {
          caregiverId: selectedCaregiverId,
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
      console.error('Failed to load escalations', error);
      const message = getApiError(error, 'Unable to load escalations.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setEscalationsLoading(false);
    }
  }, [headers, selectedCaregiverId, selectedEscalationId]);

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
        console.error('Failed to load readiness details', error);
      }
    },
    [headers, readinessByAppointment],
  );

  const loadActiveDelegations = useCallback(
    async (caregiverId) => {
      const normalizedId = String(caregiverId || '').trim();
      if (!normalizedId) return;
      try {
        const response = await axios.get(`${API_BASE_URL}/agents/${normalizedId}/delegations`, {
          headers,
        });
        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        setDelegationsByCaregiver((prev) => ({ ...prev, [normalizedId]: rows }));
      } catch (error) {
        console.error('Failed to load active delegations', error);
      }
    },
    [headers],
  );

  useEffect(() => {
    if (normalizedRole !== 'COORDINATOR') return;
    loadThreads();
  }, [loadThreads, normalizedRole]);

  useEffect(() => {
    if (!selectedCaregiverId || normalizedRole !== 'COORDINATOR') return;
    loadThreadMessages();
    loadEscalations();
    loadActiveDelegations(selectedCaregiverId);
  }, [loadActiveDelegations, loadEscalations, loadThreadMessages, normalizedRole, selectedCaregiverId]);

  useEffect(() => {
    if (!selectedEscalation?.appointmentId) return;
    loadReadinessForAppointment(selectedEscalation.appointmentId);
  }, [loadReadinessForAppointment, selectedEscalation]);

  useEffect(() => {
    const caregiverFromNav = String(returnCaregiverId || '').trim();
    if (caregiverFromNav) {
      setSelectedCaregiverId(caregiverFromNav);
    }
    const escalationFromNav = String(focusEscalationId || '').trim();
    if (escalationFromNav) {
      setSelectedEscalationId(escalationFromNav);
    }
  }, [focusEscalationId, returnCaregiverId]);

  useEffect(() => {
    setActionNotice('');
  }, [selectedEscalationId]);

  useEffect(() => {
    if (normalizedRole !== 'COORDINATOR') return undefined;
    const interval = setInterval(() => {
      loadThreads();
      if (selectedCaregiverId) {
        loadThreadMessages();
        loadEscalations();
      }
    }, 6000);
    return () => clearInterval(interval);
  }, [loadEscalations, loadThreadMessages, loadThreads, normalizedRole, selectedCaregiverId]);

  const postThreadMessage = async () => {
    const text = composer.trim();
    if (!text || !selectedCaregiverId) {
      setActionNotice('Select a caregiver and enter a message.');
      return;
    }

    try {
      setSendingMessage(true);
      await axios.post(
        `${API_BASE_URL}/scheduler/threads/${selectedCaregiverId}/messages`,
        {
          content: text,
          escalationId: selectedEscalation?.id,
        },
        { headers },
      );
      setComposer('');
      await Promise.all([loadThreadMessages(), loadThreads()]);
      setActionNotice('Scheduler message sent.');
    } catch (error) {
      console.error('Failed to send scheduler thread message', error);
      const message = getApiError(error, 'Unable to send scheduler message.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setSendingMessage(false);
    }
  };

  const updateEscalationStatus = async (status) => {
    const targetEscalation = selectedEscalation;
    if (!targetEscalation?.id) {
      setActionNotice('Select an escalation first.');
      Alert.alert('No escalation selected', 'Select an escalation first.');
      return;
    }

    try {
      setStatusUpdating(true);
      await axios.patch(
        `${API_BASE_URL}/escalations/${targetEscalation.id}`,
        {
          status,
          resolutionType: status === 'RESOLVED' ? 'SCHEDULER_RESOLVED' : undefined,
          resolutionNote: status === 'RESOLVED' ? 'Resolved by scheduler in Scheduler Desk.' : undefined,
        },
        { headers },
      );
      await Promise.all([loadEscalations(), loadThreadMessages(), loadThreads()]);
      setActionNotice(`Escalation marked ${status}.`);
    } catch (error) {
      console.error('Failed to update escalation status', error);
      const message = getApiError(error, 'Unable to update escalation status.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setStatusUpdating(false);
    }
  };

  const openAppointmentChat = async () => {
    const targetEscalation = selectedEscalation;
    if (!targetEscalation?.appointmentId || !selectedCaregiverId) {
      const message = 'This escalation has no appointment chat linked.';
      setActionNotice(message);
      Alert.alert('No appointment linked', message);
      return;
    }

    try {
      setOpeningChat(true);
      await axios.post(
        `${API_BASE_URL}/scheduler/threads/${selectedCaregiverId}/messages`,
        {
          content: 'Opened appointment chat for live intervention.',
          escalationId: targetEscalation.id,
          metadata: {
            eventType: 'SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT',
            escalationId: targetEscalation.id,
            appointmentId: targetEscalation.appointmentId,
          },
        },
        { headers },
      );
    } catch (error) {
      console.warn('Failed to append appointment-chat transition note', error);
      const message = getApiError(error, 'Opened chat, but failed to log transition note.');
      setActionNotice(message);
      Alert.alert('Heads up', message);
    } finally {
      setOpeningChat(false);
    }

    router.push({
      pathname: `/chat/${targetEscalation.appointmentId}`,
      params: {
        role: 'COORDINATOR',
        userId: normalizedUserId,
        authToken,
        returnCaregiverId: selectedCaregiverId,
        returnThreadId: selectedThread?.threadId || '',
        fromEscalationId: targetEscalation.id,
      },
    });
    setActionNotice('Opened appointment chat.');
  };

  const updateReadinessCheck = async (checkType, nextStatus) => {
    if (!selectedEscalation?.appointmentId) return;

    const existingCheck = selectedReadiness?.checks?.find((item) => item.check_type === checkType);
    const previousStatus = String(existingCheck?.status || 'PENDING').toUpperCase();
    const isFailToPassOverride = previousStatus === 'FAIL' && nextStatus === 'PASS';

    if (isFailToPassOverride && !overrideReason.trim()) {
      const message = 'Enter override reason before changing FAIL to PASS.';
      setActionNotice(message);
      Alert.alert('Override reason required', message);
      return;
    }

    try {
      setUpdatingReadinessKey(checkType);
      await axios.post(
        `${API_BASE_URL}/appointments/${selectedEscalation.appointmentId}/readiness/checks`,
        {
          checkType,
          status: nextStatus,
          source: 'MANUAL',
          overrideReason: isFailToPassOverride ? overrideReason.trim() : undefined,
        },
        { headers },
      );
      setReadinessByAppointment((prev) => {
        const next = { ...prev };
        delete next[selectedEscalation.appointmentId];
        return next;
      });
      await loadReadinessForAppointment(selectedEscalation.appointmentId);
      setActionNotice(`Readiness check ${checkType} updated to ${nextStatus}.`);
    } catch (error) {
      console.error('Failed to update readiness check', error);
      const message = getApiError(error, 'Unable to update readiness check.');
      setActionNotice(message);
      Alert.alert('Error', message);
    } finally {
      setUpdatingReadinessKey('');
    }
  };

  if (normalizedRole !== 'COORDINATOR') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.deniedWrap}>
          <Text style={styles.deniedTitle}>Scheduler access required</Text>
          <Text style={styles.deniedText}>Sign in as a coordinator to use Scheduler Desk.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerCard}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Scheduler Desk</Text>
            <Text style={styles.subtitle}>Manage caregiver escalations and open appointment chat when live intervention is needed.</Text>
          </View>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() =>
              router.push({
                pathname: '/appointment-list',
                params: {
                  role: 'COORDINATOR',
                  userId: normalizedUserId,
                  authToken,
                },
              })
            }
          >
            <Text style={styles.secondaryButtonText}>All Appointments</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Caregiver Threads</Text>
            {threadsLoading ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>

          {!threadsLoading && threads.length === 0 ? (
            <Text style={styles.emptyText}>No scheduler threads yet.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.threadRail}>
              {threads.map((thread) => {
                const active = selectedCaregiverId === thread.caregiverId;
                return (
                  <TouchableOpacity
                    key={thread.caregiverId}
                    style={[styles.threadChip, active && styles.threadChipActive]}
                    onPress={() => setSelectedCaregiverId(thread.caregiverId)}
                  >
                    <Text style={[styles.threadChipName, active && styles.threadChipNameActive]}>{thread.caregiverName}</Text>
                    <Text style={[styles.threadChipMeta, active && styles.threadChipMetaActive]}>
                      Open escalations: {thread.openEscalationCount}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Scheduler Conversation</Text>
            {messagesLoading ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>

          {!selectedCaregiverId ? (
            <Text style={styles.emptyText}>Select a caregiver thread to view conversation.</Text>
          ) : (
            <>
              <Text style={styles.threadMetaLine}>
                {selectedThread?.caregiverName || 'Caregiver'} • Last update {formatRelativeTime(selectedThread?.lastActivityAt)}
              </Text>

              {visibleMessages.length === 0 ? (
                <Text style={styles.emptyText}>No messages yet.</Text>
              ) : (
                <View style={styles.messageFeed}>
                  {visibleMessages.map((message) => {
                    const linkedEscalation = message.escalationId
                      ? escalations.find((item) => item.id === message.escalationId)
                      : null;
                    const senderType = String(message.senderType || '').toUpperCase();
                    const mine = senderType === 'CAREGIVER';
                    const system = senderType === 'SYSTEM';

                    return (
                      <TouchableOpacity
                        key={message.id}
                        style={[styles.messageCard, mine && styles.messageCardMine, system && styles.messageCardSystem]}
                        activeOpacity={linkedEscalation ? 0.75 : 1}
                        onPress={() => {
                          if (linkedEscalation?.id) setSelectedEscalationId(linkedEscalation.id);
                        }}
                      >
                        <View style={styles.messageRowTop}>
                          <Text style={styles.messageSender}>{senderType}</Text>
                          <Text style={styles.messageTime}>{formatTimeStamp(message.createdAt)}</Text>
                        </View>
                        <Text style={styles.messageContent}>{message.content}</Text>
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
                  placeholder="Message caregiver in scheduler thread"
                  placeholderTextColor={DS.colors.textMuted}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.primaryButton, sendingMessage && styles.primaryButtonDisabled]}
                  onPress={postThreadMessage}
                  disabled={sendingMessage}
                >
                  <Text style={styles.primaryButtonText}>{sendingMessage ? 'Sending...' : 'Send'}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Escalation List</Text>
            {escalationsLoading ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>

          {escalations.length === 0 ? (
            <Text style={styles.emptyText}>No escalations for this caregiver thread.</Text>
          ) : (
            <View style={styles.escalationBoard}>
              {escalations.map((item) => {
                const active = item.id === selectedEscalationId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.escalationCard, active && styles.escalationCardActive]}
                    onPress={() => setSelectedEscalationId(item.id)}
                  >
                    <Text style={styles.escalationCardSummary}>{item.summary}</Text>
                    <View style={styles.statusRow}>
                      <Text style={styles.statusChip}>{item.status}</Text>
                      <Text style={styles.categoryChip}>{item.category}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Escalation Context</Text>
            {(statusUpdating || openingChat) ? <ActivityIndicator size="small" color={DS.colors.brand} /> : null}
          </View>
          {actionNotice ? <Text style={styles.noticeText}>{actionNotice}</Text> : null}

          {!selectedEscalation ? (
            <Text style={styles.emptyText}>Select an escalation from the list above.</Text>
          ) : (
            <>
              <Text style={styles.contextSummary}>{selectedEscalation.summary}</Text>
              <View style={styles.statusRow}>
                <Text style={styles.statusChip}>{selectedEscalation.status}</Text>
                <Text style={styles.categoryChip}>{selectedEscalation.category}</Text>
              </View>
              <Text style={styles.contextMeta}>Opened {formatTimeStamp(selectedEscalation.openedAt)}</Text>

              <View style={styles.actionRow}>
                {canAcknowledge ? (
                  <TouchableOpacity
                    style={[styles.ghostButton, statusUpdating && styles.ghostButtonDisabled]}
                    onPress={() => updateEscalationStatus('ACKNOWLEDGED')}
                    disabled={statusUpdating}
                  >
                    <Text style={styles.ghostButtonText}>Mark Acknowledged</Text>
                  </TouchableOpacity>
                ) : null}
                {canResolve ? (
                  <TouchableOpacity
                    style={[styles.ghostButton, statusUpdating && styles.ghostButtonDisabled]}
                    onPress={() => updateEscalationStatus('RESOLVED')}
                    disabled={statusUpdating}
                  >
                    <Text style={styles.ghostButtonText}>Mark Resolved</Text>
                  </TouchableOpacity>
                ) : null}
                {isClosedEscalation ? <Text style={styles.closedHint}>This escalation is closed.</Text> : null}
              </View>

              <TouchableOpacity
                style={[
                  styles.primaryButtonWide,
                  (!selectedEscalation.appointmentId || openingChat) && styles.primaryButtonWideDisabled,
                ]}
                onPress={openAppointmentChat}
                disabled={!selectedEscalation.appointmentId || openingChat}
              >
                <Text style={styles.primaryButtonText}>
                  {!selectedEscalation.appointmentId
                    ? 'No Appointment Chat Linked'
                    : openingChat
                      ? 'Opening...'
                      : 'Open Appointment Chat'}
                </Text>
              </TouchableOpacity>

              <Text style={styles.subsectionTitle}>Appointment Readiness (Critical)</Text>
              {selectedEscalation.appointmentId ? (
                selectedReadiness ? (
                  selectedReadiness.checks
                    .filter((check) => CRITICAL_CHECKS.has(String(check.check_type || '').toUpperCase()))
                    .map((check) => (
                      <View key={check.check_type} style={styles.checkCard}>
                        <View style={styles.checkHeader}>
                          <Text style={styles.checkType}>{check.check_type}</Text>
                          <Text style={styles.checkStatus}>{check.status}</Text>
                        </View>
                        <Text style={styles.checkDescription}>{check.description}</Text>

                        <View style={styles.checkActionRow}>
                          <TouchableOpacity
                            style={[styles.checkActionButton, updatingReadinessKey === check.check_type && styles.checkActionButtonDisabled]}
                            onPress={() => updateReadinessCheck(check.check_type, 'PASS')}
                            disabled={Boolean(updatingReadinessKey)}
                          >
                            <Text style={styles.checkActionText}>PASS</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.checkActionButton, updatingReadinessKey === check.check_type && styles.checkActionButtonDisabled]}
                            onPress={() => updateReadinessCheck(check.check_type, 'PENDING')}
                            disabled={Boolean(updatingReadinessKey)}
                          >
                            <Text style={styles.checkActionText}>PENDING</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.checkActionButton, updatingReadinessKey === check.check_type && styles.checkActionButtonDisabled]}
                            onPress={() => updateReadinessCheck(check.check_type, 'FAIL')}
                            disabled={Boolean(updatingReadinessKey)}
                          >
                            <Text style={styles.checkActionText}>FAIL</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))
                ) : (
                  <Text style={styles.emptyText}>Loading readiness checks...</Text>
                )
              ) : (
                <Text style={styles.emptyText}>No appointment linked to this escalation.</Text>
              )}

              <TextInput
                style={styles.reasonInput}
                value={overrideReason}
                onChangeText={setOverrideReason}
                placeholder="Reason required only for FAIL -> PASS override"
                placeholderTextColor={DS.colors.textMuted}
              />
              <Text style={styles.reasonHelp}>Use this only when manually overriding a failed critical check to pass.</Text>

              <Text style={styles.subsectionTitle}>Delegation Status</Text>
              {selectedDelegation ? (
                <View style={styles.delegationCard}>
                  <Text style={styles.delegationLine}>Status: Active</Text>
                  <Text style={styles.delegationLine}>Window ends: {formatTimeStamp(selectedDelegation.endsAt)}</Text>
                  <Text style={styles.delegationLine}>Objective: {selectedDelegation.objective || 'n/a'}</Text>
                </View>
              ) : (
                <Text style={styles.emptyText}>No active delegation for this appointment.</Text>
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

function formatRelativeTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'unknown';
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(deltaMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
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
    gap: DS.spacing.sm,
  },
  headerCopy: {
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
  secondaryButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
    backgroundColor: DS.colors.surface,
  },
  secondaryButtonText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  sectionCard: {
    ...baseStyles.card,
    marginBottom: DS.spacing.sm,
    padding: DS.spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DS.spacing.xs,
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.caption,
  },
  threadRail: {
    gap: DS.spacing.xs,
  },
  threadChip: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.sm,
    minWidth: 190,
    backgroundColor: DS.colors.surface,
  },
  threadChipActive: {
    borderColor: DS.colors.brand,
    backgroundColor: '#E9F5F3',
  },
  threadChipName: {
    color: DS.colors.textPrimary,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  threadChipNameActive: {
    color: DS.colors.brandStrong,
  },
  threadChipMeta: {
    color: DS.colors.textMuted,
    marginTop: 2,
    fontSize: DS.typography.micro,
  },
  threadChipMetaActive: {
    color: DS.colors.brandStrong,
  },
  threadMetaLine: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginBottom: DS.spacing.xs,
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
  messageRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  messageContent: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
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
  escalationBoard: {
    marginTop: DS.spacing.xs,
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
  escalationCardSummary: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
    fontWeight: '700',
  },
  contextSummary: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    lineHeight: 22,
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
  contextMeta: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: DS.spacing.xs,
  },
  noticeText: {
    marginBottom: DS.spacing.xs,
    color: DS.colors.info,
    fontSize: DS.typography.micro,
    lineHeight: 16,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DS.spacing.xs,
    marginTop: DS.spacing.sm,
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
    backgroundColor: DS.colors.surface,
  },
  ghostButtonDisabled: {
    opacity: 0.6,
  },
  ghostButtonText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  closedHint: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    paddingVertical: 6,
  },
  subsectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
    marginTop: DS.spacing.md,
    marginBottom: DS.spacing.xs,
  },
  checkCard: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    padding: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
    backgroundColor: DS.colors.surface,
  },
  checkHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  checkType: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  checkStatus: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  checkDescription: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: 4,
    lineHeight: 16,
  },
  checkActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DS.spacing.xs,
    marginTop: DS.spacing.xs,
  },
  checkActionButton: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
  },
  checkActionButtonDisabled: {
    opacity: 0.6,
  },
  checkActionText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  reasonInput: {
    marginTop: DS.spacing.sm,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
  },
  reasonHelp: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: DS.spacing.xxs,
    lineHeight: 16,
  },
  delegationCard: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    padding: DS.spacing.sm,
  },
  delegationLine: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    marginBottom: 4,
  },
  emptyText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  deniedWrap: {
    ...baseStyles.card,
    margin: DS.spacing.md,
    padding: DS.spacing.md,
  },
  deniedTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
    marginBottom: DS.spacing.xs,
  },
  deniedText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
});
