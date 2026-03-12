import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, Alert, Modal, ActivityIndicator, ScrollView } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import axios from 'axios';
import { API_BASE_URL } from '../../constants/Config';
import { DS, baseStyles } from '../../design/system';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ChatScreen() {
  const {
    id,
    role,
    userId,
    authToken,
    clientName,
    clientId,
    appointmentStartTime,
    contextSource,
    returnCaregiverId,
    returnThreadId,
    fromEscalationId,
  } = useLocalSearchParams();
  const appointmentId = String(id || '');
  const currentRole = String(role || 'CAREGIVER').toUpperCase();
  const currentUserId = String(userId || 'demo-user');
  const router = useRouter();
  const showSchedulerReturn = currentRole === 'COORDINATOR' && Boolean(returnCaregiverId);

  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);
  const [context, setContext] = useState({
    clientName: String(clientName || ''),
    clientId: String(clientId || ''),
    appointmentStartTime: String(appointmentStartTime || ''),
    source: String(contextSource || 'selected_appointment'),
  });
  const [clientAppointments, setClientAppointments] = useState([]);
  const [loadingClientAppointments, setLoadingClientAppointments] = useState(false);
  const [switchVisitOpen, setSwitchVisitOpen] = useState(false);
  const [contextResolved, setContextResolved] = useState(false);
  const flatListRef = useRef(null);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 3000);
    return () => clearInterval(interval);
  }, [appointmentId]);

  useEffect(() => {
    if (contextResolved) return;
    resolveAppointmentContext();
  }, [appointmentId, contextResolved]);

  useEffect(() => {
    setContextResolved(false);
  }, [appointmentId]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/appointments/${appointmentId}/messages`, {
        params: { role: currentRole, userId: currentUserId },
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      setHistory(res.data.data);
    } catch (e) {
      console.error('Fetch Error:', e);
    }
  };

  const handleSend = async () => {
    if (!message.trim()) return;

    const tempMsg = {
      id: Date.now().toString(),
      content: message,
      sender_type: currentRole,
      created_at: new Date().toISOString(),
    };

    setHistory((prev) => [...prev, tempMsg]);
    setMessage('');
    setTimeout(() => flatListRef.current?.scrollToEnd(), 100);

    try {
      await axios.post(`${API_BASE_URL}/messages`, {
        appointmentId,
        content: tempMsg.content,
        senderType: currentRole,
        senderId: currentUserId,
      }, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      fetchHistory();
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Failed to send message');
    }
  };

  const isMe = (msgSenderType) => msgSenderType === currentRole;

  const resolveAppointmentContext = async () => {
    try {
      setLoadingClientAppointments(true);
      const res = await axios.get(`${API_BASE_URL}/appointments`, {
        params: { userId: currentUserId, role: currentRole },
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      const list = Array.isArray(res.data) ? res.data : [];
      const match = list.find((item) => String(item.id) === appointmentId);
      if (!match) return;
      const resolvedClientId = String(clientId || match.client_id || '').trim();
      const resolvedClientName = String(match.client_name || clientName || '').trim();
      const sameClientAppointments = list
        .filter((item) => {
          if (resolvedClientId) return String(item.client_id || '').trim() === resolvedClientId;
          return String(item.client_name || '').trim() === resolvedClientName;
        })
        .sort((a, b) => new Date(b.start_time || '').getTime() - new Date(a.start_time || '').getTime());
      setClientAppointments(sameClientAppointments);
      setContext({
        clientName: resolvedClientName,
        clientId: resolvedClientId,
        appointmentStartTime: String(match.start_time || ''),
        source: context.source === 'selected_client_conversation' ? 'selected_client_conversation' : 'resolved_from_appointments',
      });
    } catch (e) {
      console.error('Failed to resolve chat context', e);
    } finally {
      setLoadingClientAppointments(false);
      setContextResolved(true);
    }
  };

  const switchToAppointment = (targetAppointment) => {
    if (!targetAppointment?.id || String(targetAppointment.id) === appointmentId) {
      setSwitchVisitOpen(false);
      return;
    }
    setSwitchVisitOpen(false);
    router.replace({
      pathname: `/chat/${targetAppointment.id}`,
      params: {
        role: currentRole,
        userId: currentUserId,
        authToken,
        clientName: String(targetAppointment.client_name || context.clientName || ''),
        clientId: String(targetAppointment.client_id || context.clientId || ''),
        appointmentStartTime: String(targetAppointment.start_time || ''),
        contextSource: 'selected_client_conversation',
        returnCaregiverId: String(returnCaregiverId || ''),
        returnThreadId: String(returnThreadId || ''),
        fromEscalationId: String(fromEscalationId || ''),
      },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        style={styles.container}
      >
        <Stack.Screen options={{ title: `Chat (${currentRole})` }} />

        {showSchedulerReturn ? (
          <View style={styles.schedulerReturnBar}>
            <TouchableOpacity
              style={styles.schedulerReturnBtn}
              onPress={() =>
                router.push({
                  pathname: '/scheduler-desk',
                  params: {
                    role: currentRole,
                    userId: currentUserId,
                    authToken,
                    returnCaregiverId: String(returnCaregiverId || ''),
                    returnThreadId: String(returnThreadId || ''),
                    fromEscalationId: String(fromEscalationId || ''),
                  },
                })
              }
            >
              <Text style={styles.schedulerReturnBtnText}>Back to Scheduler Thread</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.contextBar}>
          <View style={styles.contextTextWrap}>
            <Text style={styles.contextTitle}>
              Context: {context.clientName || 'Unknown client'}
              {context.appointmentStartTime ? ` • ${formatApptDateTime(context.appointmentStartTime)}` : ''}
            </Text>
            <Text style={styles.contextMeta}>
              Source: {context.source === 'selected_client_conversation' ? 'Client conversation view' : context.source === 'selected_appointment' ? 'Selected visit' : 'Resolved from schedule'}
            </Text>
          </View>
          <View style={styles.contextActions}>
            <TouchableOpacity style={styles.switchBtn} onPress={() => setSwitchVisitOpen(true)}>
              <Text style={styles.switchBtnText}>Switch Visit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.allVisitsBtn}
              onPress={() =>
                router.push({
                  pathname: '/appointment-list',
                  params: { role: currentRole, userId: currentUserId, authToken },
                })
              }
            >
              <Text style={styles.allVisitsBtnText}>All Visits</Text>
            </TouchableOpacity>
          </View>
        </View>

        {currentRole === 'CAREGIVER' && (
          <View style={styles.agentBar}>
            <View style={{ flex: 1, paddingRight: DS.spacing.sm }}>
              <Text style={styles.agentTitle}>Agent is managed from Agent Desk</Text>
              <Text style={styles.agentSubtitle}>
                Use free-form commands there to start delegation and return here for follow-ups and summaries.
              </Text>
            </View>
            <TouchableOpacity
              style={styles.agentDeskBtn}
              onPress={() =>
                router.push({
                  pathname: '/agent-command-center',
                  params: { role: currentRole, userId: currentUserId, authToken },
                })
              }
            >
              <Text style={styles.agentDeskBtnText}>Open Desk</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          ref={flatListRef}
          data={history}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
          renderItem={({ item }) => {
            const amIMe = isMe(item.sender_type);
            const isAI = item.sender_type === 'AI_AGENT';

            return (
              <View
                style={[
                  styles.bubble,
                  amIMe ? styles.myBubble : styles.theirBubble,
                  isAI && styles.aiBubble,
                ]}
              >
                <Text style={[styles.bubbleText, !amIMe && styles.theirText, isAI && styles.aiText]}>
                  {item.content}
                </Text>

                {!amIMe && (
                  <Text style={styles.senderLabel}>
                    {isAI ? 'Digital Twin' : item.sender_type}
                  </Text>
                )}
              </View>
            );
          }}
        />

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={message}
            onChangeText={setMessage}
            placeholder={`Message as ${currentRole}...`}
            placeholderTextColor={DS.colors.textMuted}
            returnKeyType="send"
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity onPress={handleSend} style={styles.sendButton}>
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={switchVisitOpen} animationType="slide" transparent onRequestClose={() => setSwitchVisitOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Switch Visit</Text>
              <Text style={styles.modalSubtitle}>{context.clientName || 'Client'}</Text>
              {loadingClientAppointments ? (
                <View style={styles.loaderWrap}>
                  <ActivityIndicator size="small" color={DS.colors.brand} />
                </View>
              ) : (
                <ScrollView style={styles.modalList}>
                  {clientAppointments.length === 0 ? (
                    <Text style={styles.modalEmpty}>No visits found for this client.</Text>
                  ) : (
                    clientAppointments.map((item) => {
                      const selected = String(item.id) === appointmentId;
                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={[styles.modalOption, selected && styles.modalOptionSelected]}
                          disabled={selected}
                          onPress={() => switchToAppointment(item)}
                        >
                          <Text style={[styles.modalOptionText, selected && styles.modalOptionTextSelected]}>
                            {formatApptDateTime(item.start_time)}
                          </Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>
              )}
              <TouchableOpacity style={styles.modalDoneBtn} onPress={() => setSwitchVisitOpen(false)}>
                <Text style={styles.modalDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function formatApptDateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }
  return `${date.toLocaleDateString()} • ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

const styles = StyleSheet.create({
  safeArea: {
    ...baseStyles.screen,
  },
  container: {
    ...baseStyles.screen,
  },
  schedulerReturnBar: {
    paddingHorizontal: DS.spacing.md,
    paddingTop: DS.spacing.xs,
    paddingBottom: DS.spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: DS.colors.border,
    backgroundColor: '#F1F7F6',
  },
  schedulerReturnBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#B7D8D3',
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: '#E7F2F0',
  },
  schedulerReturnBtnText: {
    color: DS.colors.brandStrong,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  contextBar: {
    backgroundColor: DS.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: DS.colors.border,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  contextTextWrap: {
    flex: 1,
    paddingRight: DS.spacing.sm,
  },
  contextActions: {
    alignItems: 'flex-end',
    gap: DS.spacing.xs,
  },
  contextTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  contextMeta: {
    marginTop: DS.spacing.xxs,
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
  },
  switchBtn: {
    backgroundColor: DS.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
  },
  switchBtnText: {
    color: DS.colors.textSecondary,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  allVisitsBtn: {
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: '#ECF2FC',
    borderWidth: 1,
    borderColor: '#C9D8F4',
  },
  allVisitsBtnText: {
    color: '#1E4F9A',
    fontWeight: '700',
    fontSize: DS.typography.micro,
  },
  agentBar: {
    backgroundColor: DS.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: DS.colors.border,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  agentTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  agentSubtitle: {
    marginTop: DS.spacing.xxs,
    fontSize: DS.typography.micro,
    color: DS.colors.textSecondary,
  },
  agentDeskBtn: {
    backgroundColor: DS.colors.brand,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
  },
  agentDeskBtnText: {
    color: DS.colors.surface,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  listContent: {
    padding: DS.spacing.md,
    paddingBottom: DS.spacing.lg,
  },
  bubble: {
    padding: DS.spacing.sm,
    borderRadius: DS.radius.md,
    marginBottom: DS.spacing.sm,
    maxWidth: '82%',
  },
  myBubble: {
    backgroundColor: DS.colors.brand,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: DS.colors.surface,
    borderWidth: 1,
    borderColor: DS.colors.border,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  aiBubble: {
    backgroundColor: '#FFF4E7',
    borderColor: '#F1C88D',
  },
  bubbleText: {
    color: DS.colors.surface,
    fontSize: DS.typography.body,
  },
  theirText: {
    color: DS.colors.textPrimary,
  },
  aiText: {
    color: '#8A4B00',
    fontStyle: 'italic',
  },
  senderLabel: {
    fontSize: DS.typography.micro,
    color: DS.colors.textMuted,
    marginTop: DS.spacing.xxs,
    textTransform: 'capitalize',
  },
  inputContainer: {
    flexDirection: 'row',
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: DS.colors.border,
    backgroundColor: DS.colors.surface,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: DS.colors.surfaceMuted,
    borderRadius: DS.radius.pill,
    borderWidth: 1,
    borderColor: DS.colors.border,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 10,
    marginRight: DS.spacing.xs,
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
  },
  sendButton: {
    height: 40,
    borderRadius: DS.radius.pill,
    backgroundColor: DS.colors.brand,
    paddingHorizontal: DS.spacing.md,
    justifyContent: 'center',
  },
  sendText: {
    color: DS.colors.surface,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(9, 23, 24, 0.36)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: DS.colors.surface,
    borderTopLeftRadius: DS.radius.lg,
    borderTopRightRadius: DS.radius.lg,
    padding: DS.spacing.md,
    maxHeight: '70%',
  },
  modalTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
  },
  modalSubtitle: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xxs,
    marginBottom: DS.spacing.sm,
  },
  modalList: {
    maxHeight: 280,
  },
  modalOption: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.sm,
    backgroundColor: DS.colors.surface,
    marginBottom: DS.spacing.xs,
  },
  modalOptionSelected: {
    borderColor: '#B3DCD5',
    backgroundColor: '#DFF3EF',
  },
  modalOptionText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '600',
  },
  modalOptionTextSelected: {
    color: DS.colors.brandStrong,
  },
  modalEmpty: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  modalDoneBtn: {
    backgroundColor: DS.colors.brand,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    alignItems: 'center',
    marginTop: DS.spacing.sm,
  },
  modalDoneText: {
    color: DS.colors.surface,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  loaderWrap: {
    paddingVertical: DS.spacing.md,
    alignItems: 'center',
  },
});
