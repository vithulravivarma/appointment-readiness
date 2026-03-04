import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  Modal,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { DS, baseStyles } from '../design/system';

type AppointmentRow = {
  id: string;
  client_name: string;
  service_type: string;
  start_time?: string;
};

type DelegationRow = {
  appointmentId: string;
  active: boolean;
  objective: string;
  questions: string[];
  startedAt: string;
  endsAt: string;
  summary?: string;
  summaryGeneratedAt?: string;
  clientName?: string;
  appointmentStartTime?: string;
};

type ReadinessCheckRow = {
  check_type: string;
  status: 'PENDING' | 'PASS' | 'FAIL';
  critical: boolean;
  description: string;
  updated_at?: string | null;
};

type CheckDefinition = {
  key: string;
  critical: boolean;
  description: string;
};

type CommandMode = 'DELEGATION_STARTED' | 'ANSWERED' | 'SUGGESTION' | 'FOLLOW_UP';

type CommandHistoryItem = {
  id: string;
  actor: 'CAREGIVER' | 'AGENT';
  text: string;
  mode?: CommandMode;
};

type AgentCommandResponse = {
  mode?: CommandMode;
  response?: string;
  resolvedAppointment?: {
    appointmentId?: string;
    clientName?: string;
    appointmentStartTime?: string;
  };
  action?: {
    type?: string;
    appointmentId?: string;
  };
};

type AgentDeskHistoryRow = {
  id: string;
  actorType: 'CAREGIVER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  source?: string;
};

export default function AgentCommandCenter() {
  const params = useLocalSearchParams();
  const userId = String(params.userId || '00000000-0000-0000-0000-000000000002');
  const authToken = String(params.authToken || '');
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [activeDelegations, setActiveDelegations] = useState<DelegationRow[]>([]);
  const [summaries, setSummaries] = useState<DelegationRow[]>([]);

  const [clientFilter, setClientFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [appointmentId, setAppointmentId] = useState('');
  const [showLaterAppointments, setShowLaterAppointments] = useState(false);

  const [objective, setObjective] = useState('Collect logistics updates and keep client informed of ETA.');
  const [questionInput, setQuestionInput] = useState('Any access code changes?, Any pet/safety notes?');
  const [duration, setDuration] = useState('30');
  const [commandInput, setCommandInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([]);
  const [runningCommand, setRunningCommand] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const { height: viewportHeight } = useWindowDimensions();

  const [checkDefinitions, setCheckDefinitions] = useState<CheckDefinition[]>([]);
  const [readinessChecks, setReadinessChecks] = useState<ReadinessCheckRow[]>([]);
  const [loadingChecks, setLoadingChecks] = useState(false);
  const [updatingCheckKey, setUpdatingCheckKey] = useState('');

  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!appointmentId) {
      setReadinessChecks([]);
      return;
    }

    loadReadiness(appointmentId);
  }, [appointmentId]);

  const sortedAppointments = useMemo(() => {
    return [...appointments].sort((a, b) => {
      const left = new Date(a.start_time || '').getTime();
      const right = new Date(b.start_time || '').getTime();
      return right - left;
    });
  }, [appointments]);

  const appointmentLookup = useMemo(() => {
    return new Map(sortedAppointments.map((a) => [a.id, a]));
  }, [sortedAppointments]);

  const clientOptions = useMemo(() => {
    return Array.from(new Set(sortedAppointments.map((item) => item.client_name))).sort((a, b) => a.localeCompare(b));
  }, [sortedAppointments]);

  const availableDates = useMemo(() => {
    const filteredByClient = clientFilter
      ? sortedAppointments.filter((item) => item.client_name === clientFilter)
      : sortedAppointments;

    return Array.from(new Set(filteredByClient.map((item) => toIsoDate(item.start_time)).filter(Boolean))).sort((a, b) =>
      b.localeCompare(a),
    );
  }, [sortedAppointments, clientFilter]);

  const filteredAppointments = useMemo(() => {
    return sortedAppointments.filter((item) => {
      const byClient = clientFilter ? item.client_name === clientFilter : true;
      const byDate = dateFilter ? toIsoDate(item.start_time) === dateFilter : true;
      return byClient && byDate;
    });
  }, [sortedAppointments, clientFilter, dateFilter]);

  const { operationalAppointments, laterAppointments } = useMemo(
    () => splitAppointmentsByOperationalWindow(filteredAppointments),
    [filteredAppointments],
  );

  const filteredActiveDelegations = useMemo(() => {
    return activeDelegations.filter((item) => {
      const byClient = clientFilter ? item.clientName === clientFilter : true;
      const byDate = dateFilter ? toIsoDate(item.appointmentStartTime) === dateFilter : true;
      return byClient && byDate;
    });
  }, [activeDelegations, clientFilter, dateFilter]);

  const filteredSummaries = useMemo(() => {
    return summaries.filter((item) => {
      const byClient = clientFilter ? item.clientName === clientFilter : true;
      const byDate = dateFilter ? toIsoDate(item.appointmentStartTime) === dateFilter : true;
      return byClient && byDate;
    });
  }, [summaries, clientFilter, dateFilter]);

  const criticalFailedChecks = useMemo(
    () => readinessChecks.filter((check) => check.critical && check.status === 'FAIL'),
    [readinessChecks],
  );

  useEffect(() => {
    const selectionPool = operationalAppointments.length > 0 ? operationalAppointments : filteredAppointments;
    if (!selectionPool.length) {
      setAppointmentId('');
      return;
    }

    if (!selectionPool.some((item) => item.id === appointmentId)) {
      setAppointmentId(selectionPool[0].id);
    }
  }, [operationalAppointments, filteredAppointments, appointmentId]);

  useEffect(() => {
    if (dateFilter) {
      setShowLaterAppointments(true);
    }
  }, [dateFilter]);

  const loadAll = async () => {
    await Promise.all([loadAppointments(), loadDelegations(), loadSummaries(), loadCheckDefinitions(), loadAgentDeskHistory()]);
  };

  const loadAppointments = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/appointments`, {
        params: { userId, role: 'CAREGIVER' },
        headers: authHeaders,
      });
      const list = Array.isArray(res.data) ? res.data : [];
      setAppointments(list);
    } catch (error) {
      console.error('Failed to load appointments', error);
      setAppointments([]);
    }
  };

  const loadDelegations = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${userId}/delegations`, { headers: authHeaders });
      setActiveDelegations(res.data.data || []);
    } catch (error) {
      console.error('Failed to load delegations', error);
    }
  };

  const loadSummaries = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${userId}/summaries`, { headers: authHeaders });
      setSummaries(res.data.data || []);
    } catch (error) {
      console.error('Failed to load summaries', error);
    }
  };

  const loadCheckDefinitions = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/readiness/check-definitions`, { headers: authHeaders });
      setCheckDefinitions(res.data?.data || []);
    } catch (error) {
      console.error('Failed to load readiness check definitions', error);
      setCheckDefinitions([]);
    }
  };

  const loadAgentDeskHistory = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${userId}/chat/history`, {
        params: { limit: 120 },
        headers: authHeaders,
      });
      const rows: AgentDeskHistoryRow[] = Array.isArray(res.data?.data) ? res.data.data : [];
      const mapped: CommandHistoryItem[] = rows
        .slice()
        .reverse()
        .map((row) => ({
          id: String(row.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
          actor: String(row.actorType || '').toUpperCase() === 'CAREGIVER' ? 'CAREGIVER' : 'AGENT',
          text: String(row.content || ''),
          mode: undefined,
        }))
        .filter((row) => row.text.length > 0);
      setCommandHistory(mapped.slice(-120));
    } catch (error) {
      console.error('Failed to load agent desk history', error);
    }
  };

  const loadReadiness = async (apptId: string) => {
    try {
      setLoadingChecks(true);
      const res = await axios.get(`${API_BASE_URL}/appointments/${apptId}/readiness`, { headers: authHeaders });
      setReadinessChecks(res.data?.checks || []);
    } catch (error) {
      console.error('Failed to load readiness details', error);
      setReadinessChecks([]);
    } finally {
      setLoadingChecks(false);
    }
  };

  const clearFilters = () => {
    setClientFilter('');
    setDateFilter('');
  };

  const appendCommandHistory = (entry: Omit<CommandHistoryItem, 'id'>) => {
    setCommandHistory((prev) => {
      const next: CommandHistoryItem[] = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          ...entry,
        },
      ];
      return next.slice(-80);
    });
  };

  const runAgentCommandRequest = async (
    commandText: string,
    options?: { forceStart?: boolean; appendCaregiverMessage?: boolean },
  ) => {
    const forceStart = Boolean(options?.forceStart);
    const appendCaregiverMessage = options?.appendCaregiverMessage !== false;

    if (!commandText.trim()) {
      return;
    }

    if (appendCaregiverMessage) {
      appendCommandHistory({ actor: 'CAREGIVER', text: commandText.trim() });
    }

    try {
      setRunningCommand(true);
      const res = await axios.post(
        `${API_BASE_URL}/agents/${userId}/command`,
        {
          command: commandText.trim(),
          appointmentId: appointmentId || undefined,
          durationMinutes: Number(duration) || 30,
          forceStart,
        },
        { headers: authHeaders },
      );

      const data = (res.data?.data || {}) as AgentCommandResponse;
      const responseText = String(data.response || 'No response returned.');
      appendCommandHistory({
        actor: 'AGENT',
        text: responseText,
        mode: data.mode,
      });

      const resolvedAppointmentId =
        String(data.resolvedAppointment?.appointmentId || '') || String(data.action?.appointmentId || '');
      if (resolvedAppointmentId && resolvedAppointmentId !== appointmentId) {
        setAppointmentId(resolvedAppointmentId);
      }

      if (data.action?.type === 'START_DELEGATION' || data.mode === 'DELEGATION_STARTED') {
        await loadAll();
      } else {
        await loadAgentDeskHistory();
      }
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 409) {
        const failedChecks = Array.isArray(error?.response?.data?.failedChecks)
          ? error.response.data.failedChecks.map(String)
          : [];
        const responseText = String(
          error?.response?.data?.data?.response ||
            error?.response?.data?.error ||
            'Cannot start delegation because critical checks are still failed.',
        );
        appendCommandHistory({
          actor: 'AGENT',
          text: responseText,
          mode: 'SUGGESTION',
        });

        Alert.alert(
          'Critical Readiness Blocker',
          failedChecks.length > 0
            ? `Failed critical checks: ${failedChecks.join(', ')}.`
            : 'Critical checks are still failed.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Force Start',
              style: 'destructive',
              onPress: () => {
                void runAgentCommandRequest(commandText, { forceStart: true, appendCaregiverMessage: false });
              },
            },
          ],
        );
        return;
      }

      const responseText = String(error?.response?.data?.error || 'Could not process agent command.');
      appendCommandHistory({
        actor: 'AGENT',
        text: responseText,
        mode: 'SUGGESTION',
      });
      Alert.alert('Error', responseText);
    } finally {
      setRunningCommand(false);
    }
  };

  const sendCommand = async () => {
    const text = commandInput.trim();
    if (!text) {
      return;
    }

    setCommandInput('');
    await runAgentCommandRequest(text, { appendCaregiverMessage: true });
  };

  const updateReadinessCheck = async (checkType: string, status: 'PENDING' | 'PASS' | 'FAIL') => {
    if (!appointmentId) {
      return;
    }

    try {
      setUpdatingCheckKey(checkType);
      await axios.post(
        `${API_BASE_URL}/appointments/${appointmentId}/readiness/checks`,
        {
          checkType,
          status,
          source: 'CAREGIVER_AGENT_DESK',
        },
        { headers: authHeaders },
      );

      await loadReadiness(appointmentId);
      await loadAppointments();
    } catch (error) {
      console.error('Failed to update readiness check', error);
      Alert.alert('Error', 'Could not update readiness check.');
    } finally {
      setUpdatingCheckKey('');
    }
  };

  const submitDelegation = async (forceStart: boolean) => {
    const questions = questionInput
      .split(',')
      .map((q) => q.trim())
      .filter(Boolean);

    return axios.post(
      `${API_BASE_URL}/agents/${userId}/delegations/start`,
      {
        appointmentId,
        objective: objective.trim(),
        durationMinutes: Number(duration) || 30,
        questions,
        forceStart,
      },
      { headers: authHeaders },
    );
  };

  const startDelegation = async () => {
    if (!appointmentId || !objective.trim()) {
      Alert.alert('Missing details', 'Choose a visit and objective before delegating.');
      return;
    }

    try {
      await submitDelegation(false);
      await loadAll();
      Alert.alert('Delegation started', 'Agent is now handling this conversation window.');
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 409) {
        const failedChecks = error?.response?.data?.failedChecks || [];
        Alert.alert(
          'Critical Readiness Blocker',
          `Cannot start delegation yet. Failed critical checks: ${failedChecks.join(', ') || 'Unknown'}.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Force Start',
              style: 'destructive',
              onPress: async () => {
                try {
                  await submitDelegation(true);
                  await loadAll();
                  Alert.alert('Delegation started', 'Started with force override.');
                } catch (forceErr) {
                  console.error('Failed to force start delegation', forceErr);
                  Alert.alert('Error', 'Could not force start delegation.');
                }
              },
            },
          ],
        );
        return;
      }

      console.error('Failed to start delegation', error);
      Alert.alert('Error', 'Could not start delegation.');
    }
  };

  const stopDelegation = async (apptId: string) => {
    try {
      await axios.post(`${API_BASE_URL}/agents/${userId}/delegations/${apptId}/stop`, {}, { headers: authHeaders });
      await loadAll();
      Alert.alert('Delegation ended', 'Summary has been generated.');
    } catch (error) {
      console.error('Failed to stop delegation', error);
      Alert.alert('Error', 'Could not stop delegation.');
    }
  };

  const selectedAppointment = appointmentLookup.get(appointmentId);
  const chatPanelHeight = Math.max(280, Math.floor(viewportHeight * 0.48));

  const renderChatThread = () => (
    <ScrollView style={[styles.chatThread, { height: chatPanelHeight }]} contentContainerStyle={styles.chatThreadContent}>
      {commandHistory.length === 0 ? (
        <Text style={styles.commandPlaceholder}>
          Ask naturally. Examples: What is my day looking like? Do I have any gaps between visits? Start checking if access has changed.
        </Text>
      ) : null}
      {commandHistory.map((item) => {
        const isCaregiver = item.actor === 'CAREGIVER';
        const modeLabel =
          item.mode === 'DELEGATION_STARTED'
            ? 'Delegation started'
            : item.mode === 'ANSWERED'
            ? 'Answered'
            : item.mode === 'SUGGESTION'
            ? 'Suggestion'
            : item.mode === 'FOLLOW_UP'
            ? 'Follow-up'
            : null;
        return (
          <View key={item.id} style={[styles.chatRow, isCaregiver ? styles.chatRowCaregiver : styles.chatRowAgent]}>
            <Text style={styles.chatRowMeta}>
              {isCaregiver ? 'You' : 'Agent'}
              {modeLabel ? ` • ${modeLabel}` : ''}
            </Text>
            <Text style={styles.chatRowText}>{item.text}</Text>
          </View>
        );
      })}
    </ScrollView>
  );

  const renderChatComposer = () => (
    <View style={styles.chatComposer}>
      <TextInput
        style={[styles.input, styles.commandInput]}
        value={commandInput}
        onChangeText={setCommandInput}
        placeholder='Type anything for your agent...'
        placeholderTextColor={DS.colors.textMuted}
        multiline
      />
      <TouchableOpacity style={[styles.primaryBtn, runningCommand && styles.primaryBtnDisabled]} onPress={sendCommand} disabled={runningCommand}>
        <Text style={styles.primaryBtnText}>{runningCommand ? 'Working...' : 'Send'}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Agent Desk' }} />

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.panel}>
          <View style={styles.chatHeaderRow}>
            <View>
              <Text style={styles.panelTitle}>Caregiver Chat</Text>
              <Text style={styles.commandContextText}>
                Context: {selectedAppointment ? `${selectedAppointment.client_name} • ${formatDateTime(selectedAppointment.start_time)}` : 'No visit selected'}
              </Text>
            </View>
            <TouchableOpacity style={styles.chatExpandBtn} onPress={() => setChatExpanded(true)}>
              <Text style={styles.chatExpandBtnText}>Expand</Text>
            </TouchableOpacity>
          </View>
          {renderChatThread()}
          {renderChatComposer()}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Structured Delegation (Manual)</Text>

          <View style={styles.filterBar}>
            <TouchableOpacity style={styles.filterPill} onPress={() => setClientModalOpen(true)}>
              <Text style={styles.filterLabel}>Client</Text>
              <Text style={styles.filterValue}>{clientFilter || 'All clients'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.filterPill} onPress={() => setDateModalOpen(true)}>
              <Text style={styles.filterLabel}>Date</Text>
              <Text style={styles.filterValue}>{dateFilter ? formatDateLabel(dateFilter) : 'Any date'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.clearFilterPill} onPress={clearFilters}>
              <Text style={styles.clearFilterText}>Clear</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>Choose Visit</Text>
          <View style={styles.groupHeaderRow}>
            <Text style={styles.groupTitle}>Current & Soon</Text>
            <Text style={styles.groupMeta}>Operational window</Text>
          </View>
          {operationalAppointments.map((item) => {
            const selected = item.id === appointmentId;
            return (
              <TouchableOpacity
                key={item.id}
                onPress={() => setAppointmentId(item.id)}
                style={[styles.appointmentRow, selected && styles.appointmentRowSelected]}
              >
                <Text style={[styles.appointmentRowTitle, selected && styles.appointmentRowTitleSelected]}>
                  {item.client_name} • {formatDateTime(item.start_time)}
                </Text>
                <Text style={[styles.appointmentRowMeta, selected && styles.appointmentRowMetaSelected]}>
                  {item.service_type || 'Service'}
                </Text>
              </TouchableOpacity>
            );
          })}
          {operationalAppointments.length === 0 ? <Text style={styles.emptyText}>No visits in the operational window.</Text> : null}

          {laterAppointments.length > 0 ? (
            <View style={styles.groupHeaderRow}>
              <Text style={styles.groupTitle}>Later Appointments</Text>
              <TouchableOpacity style={styles.groupToggleBtn} onPress={() => setShowLaterAppointments((prev) => !prev)}>
                <Text style={styles.groupToggleBtnText}>{showLaterAppointments ? 'Hide' : `Show (${laterAppointments.length})`}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {showLaterAppointments
            ? laterAppointments.map((item) => {
                const selected = item.id === appointmentId;
                return (
                  <TouchableOpacity
                    key={`later-${item.id}`}
                    onPress={() => setAppointmentId(item.id)}
                    style={[styles.appointmentRow, selected && styles.appointmentRowSelected]}
                  >
                    <Text style={[styles.appointmentRowTitle, selected && styles.appointmentRowTitleSelected]}>
                      {item.client_name} • {formatDateTime(item.start_time)}
                    </Text>
                    <Text style={[styles.appointmentRowMeta, selected && styles.appointmentRowMetaSelected]}>
                      {item.service_type || 'Service'}
                    </Text>
                  </TouchableOpacity>
                );
              })
            : null}
          {filteredAppointments.length === 0 ? <Text style={styles.emptyText}>No visits for these filters.</Text> : null}

          <View style={styles.checklistSection}>
            <Text style={styles.checklistTitle}>Readiness Checklist</Text>
            {criticalFailedChecks.length > 0 ? (
              <Text style={styles.blockerText}>
                Critical blockers: {criticalFailedChecks.map((c) => c.check_type).join(', ')}
              </Text>
            ) : (
              <Text style={styles.hintText}>No critical blockers detected.</Text>
            )}

            {loadingChecks ? (
              <View style={styles.loaderInline}>
                <ActivityIndicator size="small" color={DS.colors.brand} />
              </View>
            ) : (
              readinessChecks.map((check) => (
                <View key={check.check_type} style={styles.checkRow}>
                  <View style={styles.checkHeader}>
                    <Text style={styles.checkName}>{check.check_type.replace(/_/g, ' ')}</Text>
                    <Text style={[styles.checkStatus, statusTone(check.status)]}>{check.status}</Text>
                  </View>
                  <Text style={styles.checkDesc}>
                    {check.description || checkDefinitions.find((d) => d.key === check.check_type)?.description || ''}
                  </Text>
                  {check.critical ? <Text style={styles.criticalBadge}>Critical</Text> : null}

                  <View style={styles.checkActions}>
                    {(['PASS', 'PENDING', 'FAIL'] as const).map((status) => {
                      const active = check.status === status;
                      const pendingUpdate = updatingCheckKey === check.check_type;
                      return (
                        <TouchableOpacity
                          key={`${check.check_type}-${status}`}
                          style={[styles.actionBtn, active && styles.actionBtnActive]}
                          onPress={() => updateReadinessCheck(check.check_type, status)}
                          disabled={pendingUpdate}
                        >
                          <Text style={[styles.actionBtnText, active && styles.actionBtnTextActive]}>
                            {pendingUpdate ? '...' : status}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))
            )}
          </View>

          <Text style={styles.label}>Objective</Text>
          <TextInput
            style={styles.input}
            value={objective}
            onChangeText={setObjective}
            placeholder="What should the agent handle?"
            placeholderTextColor={DS.colors.textMuted}
          />

          <Text style={styles.label}>Questions To Ask (comma separated)</Text>
          <TextInput
            style={styles.input}
            value={questionInput}
            onChangeText={setQuestionInput}
            placeholder="What should the agent ask the client?"
            placeholderTextColor={DS.colors.textMuted}
          />

          <Text style={styles.label}>Duration (minutes)</Text>
          <TextInput style={styles.input} keyboardType="numeric" value={duration} onChangeText={setDuration} />

          <TouchableOpacity style={styles.primaryBtn} onPress={startDelegation}>
            <Text style={styles.primaryBtnText}>Start Delegation</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Active Delegations</Text>
        </View>
        {filteredActiveDelegations.length === 0 ? <Text style={styles.emptyText}>No active delegations.</Text> : null}
        {filteredActiveDelegations.map((item) => {
          const appt = appointmentLookup.get(item.appointmentId);
          return (
            <View key={`active-${item.appointmentId}`} style={styles.card}>
              <Text style={styles.cardTitle}>{item.clientName || appt?.client_name || item.appointmentId}</Text>
              <Text style={styles.cardMeta}>Appointment: {formatDateTime(item.appointmentStartTime || appt?.start_time)}</Text>
              <Text style={styles.cardMeta}>Objective: {item.objective}</Text>
              <Text style={styles.cardMeta}>Ends: {new Date(item.endsAt).toLocaleTimeString()}</Text>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => stopDelegation(item.appointmentId)}>
                <Text style={styles.secondaryBtnText}>End + Generate Summary</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Summaries</Text>
        </View>
        {filteredSummaries.length === 0 ? <Text style={styles.emptyText}>No summaries yet.</Text> : null}
        {filteredSummaries.map((item) => (
          <View key={`${item.appointmentId}-${item.summaryGeneratedAt}`} style={styles.card}>
            <Text style={styles.cardTitle}>{item.clientName || item.appointmentId}</Text>
            <Text style={styles.cardMeta}>Appointment: {formatDateTime(item.appointmentStartTime)}</Text>
            <Text style={styles.cardMeta}>
              {item.summaryGeneratedAt ? new Date(item.summaryGeneratedAt).toLocaleString() : ''}
            </Text>
            <Text style={styles.summaryText}>{item.summary}</Text>
          </View>
        ))}
      </ScrollView>

      <Modal visible={clientModalOpen} animationType="slide" transparent onRequestClose={() => setClientModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Filter by Client</Text>
            <ScrollView style={styles.modalList}>
              <TouchableOpacity
                style={[styles.modalOption, !clientFilter && styles.modalOptionSelected]}
                onPress={() => {
                  setClientFilter('');
                  setClientModalOpen(false);
                }}
              >
                <Text style={[styles.modalOptionText, !clientFilter && styles.modalOptionTextSelected]}>All clients</Text>
              </TouchableOpacity>
              {clientOptions.map((name) => {
                const selected = clientFilter === name;
                return (
                  <TouchableOpacity
                    key={name}
                    style={[styles.modalOption, selected && styles.modalOptionSelected]}
                    onPress={() => {
                      setClientFilter(name);
                      setClientModalOpen(false);
                    }}
                  >
                    <Text style={[styles.modalOptionText, selected && styles.modalOptionTextSelected]}>{name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setClientModalOpen(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={dateModalOpen} animationType="slide" transparent onRequestClose={() => setDateModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Filter by Date</Text>

            <View style={styles.calendarHeader}>
              <TouchableOpacity onPress={() => setCalendarMonth((prev) => addMonths(prev, -1))} style={styles.calendarNav}>
                <Text style={styles.calendarNavText}>{'<'}</Text>
              </TouchableOpacity>
              <Text style={styles.calendarTitle}>{formatMonthLabel(calendarMonth)}</Text>
              <TouchableOpacity onPress={() => setCalendarMonth((prev) => addMonths(prev, 1))} style={styles.calendarNav}>
                <Text style={styles.calendarNavText}>{'>'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.weekHeader}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => (
                <Text key={d} style={styles.weekLabel}>{d}</Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {buildCalendarCells(calendarMonth).map((cell, index) => {
                if (!cell) {
                  return <View key={`empty-${index}`} style={styles.dayCell} />;
                }

                const iso = formatIsoDate(cell);
                const selected = dateFilter === iso;
                const hasData = availableDates.includes(iso);

                return (
                  <TouchableOpacity
                    key={iso}
                    style={[styles.dayCell, selected && styles.dayCellSelected, hasData && styles.dayCellHasData]}
                    onPress={() => {
                      setDateFilter(iso);
                      setDateModalOpen(false);
                    }}
                    disabled={!hasData}
                  >
                    <Text style={[styles.dayText, !hasData && styles.dayTextDisabled, selected && styles.dayTextSelected]}>
                      {cell.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.modalActionRow}>
              <TouchableOpacity
                style={styles.modalGhostBtn}
                onPress={() => {
                  setDateFilter('');
                  setDateModalOpen(false);
                }}
              >
                <Text style={styles.modalGhostText}>Any date</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setDateModalOpen(false)}>
                <Text style={styles.modalCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={chatExpanded} animationType="slide" onRequestClose={() => setChatExpanded(false)}>
        <View style={styles.chatExpandedContainer}>
          <View style={styles.chatExpandedHeader}>
            <Text style={styles.chatExpandedTitle}>Caregiver Chat</Text>
            <TouchableOpacity style={styles.chatCollapseBtn} onPress={() => setChatExpanded(false)}>
              <Text style={styles.chatCollapseBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
          {renderChatThread()}
          {renderChatComposer()}
        </View>
      </Modal>
    </View>
  );
}

function toIsoDate(value?: string): string {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return formatIsoDate(date);
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
}

function formatDateTime(value?: string): string {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }
  return `${date.toLocaleDateString()} • ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function addMonths(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function buildCalendarCells(monthDate: Date): Array<Date | null> {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<Date | null> = [];
  for (let i = 0; i < first.getDay(); i += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, month, day));
  }

  return cells;
}

function splitAppointmentsByOperationalWindow(appointments: AppointmentRow[]): {
  operationalAppointments: AppointmentRow[];
  laterAppointments: AppointmentRow[];
} {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 8).getTime();

  const operationalAppointments: AppointmentRow[] = [];
  const laterAppointments: AppointmentRow[] = [];

  for (const item of appointments) {
    const startTimeMs = new Date(item.start_time || '').getTime();
    if (!Number.isFinite(startTimeMs)) {
      laterAppointments.push(item);
      continue;
    }

    if (startTimeMs >= start && startTimeMs < end) {
      operationalAppointments.push(item);
    } else {
      laterAppointments.push(item);
    }
  }

  return { operationalAppointments, laterAppointments };
}

function statusTone(status: 'PENDING' | 'PASS' | 'FAIL') {
  if (status === 'PASS') return styles.statusPass;
  if (status === 'FAIL') return styles.statusFail;
  return styles.statusPending;
}

const styles = StyleSheet.create({
  container: {
    ...baseStyles.screen,
  },
  scrollContent: {
    padding: DS.spacing.md,
    paddingBottom: DS.spacing.xl,
  },
  panel: {
    ...baseStyles.card,
    padding: DS.spacing.md,
    marginBottom: DS.spacing.md,
  },
  panelTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
    marginBottom: DS.spacing.sm,
  },
  commandContextText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.xs,
  },
  filterBar: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
    marginBottom: DS.spacing.sm,
    alignItems: 'center',
  },
  filterPill: {
    flex: 1,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingVertical: DS.spacing.xs,
    paddingHorizontal: DS.spacing.sm,
  },
  filterLabel: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginBottom: 2,
  },
  filterValue: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  clearFilterPill: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.sm,
  },
  clearFilterText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  groupHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
  },
  groupTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  groupMeta: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  groupToggleBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
  },
  groupToggleBtnText: {
    color: DS.colors.info,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  label: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xs,
    marginBottom: DS.spacing.xxs,
  },
  appointmentRow: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
  },
  appointmentRowSelected: {
    backgroundColor: '#DFF3EF',
    borderColor: '#B3DCD5',
  },
  appointmentRowTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  appointmentRowTitleSelected: {
    color: DS.colors.brandStrong,
  },
  appointmentRowMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    marginTop: 2,
  },
  appointmentRowMetaSelected: {
    color: DS.colors.brandStrong,
  },
  checklistSection: {
    marginTop: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: '#F7FBFA',
    padding: DS.spacing.sm,
  },
  checklistTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
    marginBottom: DS.spacing.xs,
  },
  blockerText: {
    color: DS.colors.danger,
    fontSize: DS.typography.caption,
    fontWeight: '700',
    marginBottom: DS.spacing.xs,
  },
  hintText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.xs,
  },
  loaderInline: {
    paddingVertical: DS.spacing.sm,
  },
  checkRow: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    padding: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
  },
  checkHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  checkName: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
    flex: 1,
    marginRight: DS.spacing.xs,
  },
  checkStatus: {
    fontSize: DS.typography.micro,
    fontWeight: '800',
    paddingHorizontal: DS.spacing.xs,
    paddingVertical: 4,
    borderRadius: DS.radius.pill,
    overflow: 'hidden',
  },
  statusPass: {
    backgroundColor: '#E7F5EC',
    color: DS.colors.success,
  },
  statusFail: {
    backgroundColor: '#FCE9E8',
    color: DS.colors.danger,
  },
  statusPending: {
    backgroundColor: '#FBF0DF',
    color: DS.colors.warning,
  },
  checkDesc: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    marginTop: 4,
  },
  criticalBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: '#FCE9E8',
    color: DS.colors.danger,
    fontSize: DS.typography.micro,
    fontWeight: '700',
    paddingHorizontal: DS.spacing.xs,
    paddingVertical: 3,
    borderRadius: DS.radius.pill,
    overflow: 'hidden',
  },
  checkActions: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
    marginTop: DS.spacing.xs,
  },
  actionBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
  },
  actionBtnActive: {
    borderColor: DS.colors.brand,
    backgroundColor: '#DFF3EF',
  },
  actionBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  actionBtnTextActive: {
    color: DS.colors.brandStrong,
  },
  input: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 10,
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
  },
  commandInput: {
    minHeight: 76,
    textAlignVertical: 'top',
  },
  primaryBtn: {
    backgroundColor: DS.colors.brand,
    marginTop: DS.spacing.md,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    alignItems: 'center',
  },
  primaryBtnDisabled: {
    opacity: 0.65,
  },
  primaryBtnText: {
    color: DS.colors.surface,
    fontWeight: '700',
    fontSize: DS.typography.body,
  },
  chatHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
  },
  chatExpandBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
  },
  chatExpandBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  chatThread: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: '#F7FBFA',
    marginTop: DS.spacing.xs,
  },
  chatThreadContent: {
    padding: DS.spacing.sm,
    gap: DS.spacing.xs,
  },
  chatComposer: {
    marginTop: DS.spacing.sm,
  },
  commandPlaceholder: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  chatRow: {
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.xs,
  },
  chatRowCaregiver: {
    backgroundColor: '#E8F2FF',
    alignSelf: 'flex-end',
    maxWidth: '92%',
  },
  chatRowAgent: {
    backgroundColor: '#F7FBFA',
    borderWidth: 1,
    borderColor: DS.colors.border,
    alignSelf: 'flex-start',
    maxWidth: '92%',
  },
  chatRowMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    fontWeight: '700',
    marginBottom: 2,
  },
  chatRowText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  chatExpandedContainer: {
    ...baseStyles.screen,
    padding: DS.spacing.md,
  },
  chatExpandedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DS.spacing.sm,
  },
  chatExpandedTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
  },
  chatCollapseBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
  },
  chatCollapseBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  sectionHeader: {
    marginTop: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
  },
  card: {
    ...baseStyles.card,
    padding: DS.spacing.md,
    marginBottom: DS.spacing.xs,
  },
  cardTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '700',
    fontSize: DS.typography.body,
    marginBottom: DS.spacing.xxs,
  },
  cardMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.xxs,
  },
  summaryText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
    marginTop: DS.spacing.xxs,
  },
  secondaryBtn: {
    marginTop: DS.spacing.xs,
    borderWidth: 1,
    borderColor: DS.colors.brand,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.xs,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: DS.colors.brand,
    fontWeight: '700',
  },
  emptyText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.sm,
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
    maxHeight: '78%',
  },
  modalTitle: {
    color: DS.colors.textPrimary,
    fontWeight: '800',
    fontSize: DS.typography.subtitle,
    marginBottom: DS.spacing.sm,
  },
  modalList: {
    maxHeight: 260,
  },
  modalOption: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    paddingHorizontal: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
    backgroundColor: DS.colors.surface,
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
  modalCloseBtn: {
    backgroundColor: DS.colors.brand,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    alignItems: 'center',
    marginTop: DS.spacing.sm,
    minWidth: 108,
  },
  modalCloseText: {
    color: DS.colors.surface,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  modalActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: DS.spacing.sm,
  },
  modalGhostBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    paddingHorizontal: DS.spacing.md,
    backgroundColor: DS.colors.surface,
  },
  modalGhostText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DS.spacing.sm,
  },
  calendarNav: {
    width: 34,
    height: 34,
    borderRadius: DS.radius.pill,
    borderWidth: 1,
    borderColor: DS.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: DS.colors.surface,
  },
  calendarNavText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '700',
    lineHeight: DS.typography.subtitle,
  },
  calendarTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  weekHeader: {
    flexDirection: 'row',
    marginBottom: DS.spacing.xs,
  },
  weekLabel: {
    width: '14.28%',
    textAlign: 'center',
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: DS.radius.sm,
    marginBottom: 4,
  },
  dayCellHasData: {
    backgroundColor: '#EEF6F4',
  },
  dayCellSelected: {
    backgroundColor: DS.colors.brand,
  },
  dayText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '600',
  },
  dayTextDisabled: {
    color: '#BEC9CA',
  },
  dayTextSelected: {
    color: DS.colors.surface,
    fontWeight: '800',
  },
});
