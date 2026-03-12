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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
type AgentDeskTab = 'CHAT' | 'OPERATIONS';

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
  const router = useRouter();
  const userId = String(params.userId || '00000000-0000-0000-0000-000000000002');
  const authToken = String(params.authToken || '');
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [activeDelegations, setActiveDelegations] = useState<DelegationRow[]>([]);
  const [summaries, setSummaries] = useState<DelegationRow[]>([]);

  const [clientFilter, setClientFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [appointmentId, setAppointmentId] = useState('');

  const [activeTab, setActiveTab] = useState<AgentDeskTab>('CHAT');
  const [commandInput, setCommandInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([]);
  const [runningCommand, setRunningCommand] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();

  const [checkDefinitions, setCheckDefinitions] = useState<CheckDefinition[]>([]);
  const [readinessChecks, setReadinessChecks] = useState<ReadinessCheckRow[]>([]);
  const [loadingChecks, setLoadingChecks] = useState(false);
  const [updatingCheckKey, setUpdatingCheckKey] = useState('');

  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!appointmentId) {
      setReadinessChecks([]);
      return;
    }
    void loadReadiness(appointmentId);
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

  const operationalAppointments = useMemo(
    () => splitAppointmentsByOperationalWindow(filteredAppointments).operationalAppointments,
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

  const readinessSortedChecks = useMemo(() => {
    const score = (check: ReadinessCheckRow): number => {
      if (check.critical && check.status === 'FAIL') return 0;
      if (check.status === 'PENDING') return 1;
      if (!check.critical && check.status === 'FAIL') return 2;
      return 3;
    };
    return [...readinessChecks].sort((a, b) => {
      const scoreA = score(a);
      const scoreB = score(b);
      if (scoreA !== scoreB) return scoreA - scoreB;
      return String(a.check_type).localeCompare(String(b.check_type));
    });
  }, [readinessChecks]);

  const readinessSummary = useMemo(() => {
    const total = readinessChecks.length;
    const passCount = readinessChecks.filter((check) => check.status === 'PASS').length;
    const blockerCount = criticalFailedChecks.length;
    const latestUpdatedAt = readinessChecks
      .map((check) => Date.parse(String(check.updated_at || '')))
      .filter((value) => Number.isFinite(value))
      .reduce<number | null>((max, value) => (max === null || value > max ? value : max), null);

    return {
      total,
      passCount,
      blockerCount,
      latestUpdatedAt: latestUpdatedAt ? new Date(latestUpdatedAt).toLocaleString() : 'No updates yet',
    };
  }, [readinessChecks, criticalFailedChecks]);

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

  useEffect(() => {
    const interval = setInterval(() => {
      if (runningCommand) return;
      void loadAgentDeskHistory();
    }, 4000);

    return () => clearInterval(interval);
  }, [userId, authToken, runningCommand]);

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

    if (!commandText.trim()) return;

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
          durationMinutes: 30,
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
      appendCommandHistory({ actor: 'AGENT', text: responseText, mode: 'SUGGESTION' });
      Alert.alert('Error', responseText);
    } finally {
      setRunningCommand(false);
    }
  };

  const sendCommand = async () => {
    const text = commandInput.trim();
    if (!text) return;
    setCommandInput('');
    await runAgentCommandRequest(text, { appendCaregiverMessage: true });
  };

  const updateReadinessCheck = async (checkType: string, status: 'PENDING' | 'PASS' | 'FAIL') => {
    if (!appointmentId) return;

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
  const expandedChatPanelHeight = Math.max(360, Math.floor(viewportHeight * 0.62));
  const isNarrowScreen = viewportWidth < 420;

  const renderTabSwitcher = () => (
    <View style={styles.tabRow}>
      <TouchableOpacity
        style={[styles.tabBtn, activeTab === 'CHAT' && styles.tabBtnActive]}
        onPress={() => setActiveTab('CHAT')}
      >
        <Text style={[styles.tabBtnText, activeTab === 'CHAT' && styles.tabBtnTextActive]}>Chat</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.tabBtn, activeTab === 'OPERATIONS' && styles.tabBtnActive]}
        onPress={() => setActiveTab('OPERATIONS')}
      >
        <Text style={[styles.tabBtnText, activeTab === 'OPERATIONS' && styles.tabBtnTextActive]}>Operations</Text>
      </TouchableOpacity>
    </View>
  );

  const renderContextHeader = () => (
    <View style={styles.contextHeader}>
      <View style={[styles.contextHeaderMainRow, isNarrowScreen && styles.contextHeaderMainRowStacked]}>
        <View style={styles.contextHeaderTextWrap}>
          <Text style={styles.contextHeaderLabel}>Current Context</Text>
          <Text style={styles.contextHeaderTitle}>
            {selectedAppointment
              ? `${selectedAppointment.client_name} • ${formatDateTime(selectedAppointment.start_time)}`
              : 'No visit selected'}
          </Text>
          <Text style={styles.contextHeaderHint}>Use Switch to change appointment quickly.</Text>
        </View>
        <TouchableOpacity style={[styles.contextSwitchBtn, isNarrowScreen && styles.contextSwitchBtnStacked]} onPress={() => setAppointmentModalOpen(true)}>
          <Text style={styles.contextSwitchBtnText}>Switch</Text>
        </TouchableOpacity>
      </View>
      <View style={[styles.contextFilterRow, isNarrowScreen && styles.contextFilterRowStacked]}>
        <TouchableOpacity style={[styles.contextFilterPill, isNarrowScreen && styles.contextFilterPillStacked]} onPress={() => setClientModalOpen(true)}>
          <Text style={styles.contextFilterLabel}>Client</Text>
          <Text style={styles.contextFilterValue}>{clientFilter || 'All clients'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.contextFilterPill, isNarrowScreen && styles.contextFilterPillStacked]} onPress={() => setDateModalOpen(true)}>
          <Text style={styles.contextFilterLabel}>Date</Text>
          <Text style={styles.contextFilterValue}>{dateFilter ? formatDateLabel(dateFilter) : 'Any date'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.contextFilterClear, isNarrowScreen && styles.contextFilterClearStacked]} onPress={clearFilters}>
          <Text style={styles.contextFilterClearText}>Clear</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderChatThread = (height: number = chatPanelHeight) => (
    <ScrollView style={[styles.chatThread, { height }]} contentContainerStyle={styles.chatThreadContent}>
      {commandHistory.length === 0 ? (
        <Text style={styles.commandPlaceholder}>
          Ask naturally. Examples: What is my day looking like? Do I have any gaps between visits? Please contact family and confirm access updates.
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
      <TouchableOpacity
        style={[styles.primaryBtn, runningCommand && styles.primaryBtnDisabled]}
        onPress={sendCommand}
        disabled={runningCommand}
      >
        <Text style={styles.primaryBtnText}>{runningCommand ? 'Working...' : 'Send'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderChatTab = () => (
    <View style={styles.panel}>
      <View style={styles.chatHeaderRow}>
        <View style={styles.chatHeaderTextWrap}>
          <Text style={styles.panelTitle}>Caregiver Chat</Text>
          <Text style={styles.commandContextText}>Start delegation by asking in chat. Example: “Please contact family and ask about access updates.”</Text>
        </View>
        <View style={styles.chatHeaderActions}>
          <TouchableOpacity
            style={styles.chatSupportBtn}
            onPress={() =>
              router.push({
                pathname: '/scheduler-support',
                params: { role: 'CAREGIVER', userId, authToken },
              })
            }
          >
            <Text style={styles.chatSupportBtnText}>Scheduler Support</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.chatExpandBtn} onPress={() => setChatExpanded(true)}>
            <Text style={styles.chatExpandBtnText}>Open Fullscreen</Text>
          </TouchableOpacity>
        </View>
      </View>
      {renderChatThread()}
      {renderChatComposer()}
    </View>
  );

  const renderReadinessPanel = () => (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Readiness</Text>
      {!appointmentId ? <Text style={styles.emptyText}>Select a visit in Current Context to view readiness.</Text> : null}
      {!appointmentId ? null : (
        <>
          <View style={styles.readinessSummaryStrip}>
            <View style={styles.readinessMetric}>
              <Text style={styles.readinessMetricLabel}>Critical blockers</Text>
              <Text style={[styles.readinessMetricValue, readinessSummary.blockerCount > 0 && styles.readinessMetricDanger]}>
                {readinessSummary.blockerCount}
              </Text>
            </View>
            <View style={styles.readinessMetric}>
              <Text style={styles.readinessMetricLabel}>Checks passed</Text>
              <Text style={styles.readinessMetricValue}>
                {readinessSummary.passCount}/{readinessSummary.total}
              </Text>
            </View>
          </View>
          <Text style={styles.readinessUpdated}>Last updated: {readinessSummary.latestUpdatedAt}</Text>

          {criticalFailedChecks.length > 0 ? (
            <Text style={styles.blockerText}>
              Critical blockers: {criticalFailedChecks.map((c) => c.check_type.replace(/_/g, ' ')).join(', ')}
            </Text>
          ) : (
            <Text style={styles.hintText}>No critical blockers detected.</Text>
          )}

          {loadingChecks ? (
            <View style={styles.loaderInline}>
              <ActivityIndicator size="small" color={DS.colors.brand} />
            </View>
          ) : readinessSortedChecks.length === 0 ? (
            <Text style={styles.emptyText}>No readiness checks found for this appointment.</Text>
          ) : (
            readinessSortedChecks.map((check) => (
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
        </>
      )}
    </View>
  );

  const renderActiveDelegations = () => (
    <>
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
    </>
  );

  const renderRecentSummaries = () => (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent Summaries</Text>
      </View>
      {filteredSummaries.length === 0 ? <Text style={styles.emptyText}>No summaries yet.</Text> : null}
      {filteredSummaries.map((item) => (
        <View key={`${item.appointmentId}-${item.summaryGeneratedAt}`} style={styles.card}>
          <Text style={styles.cardTitle}>{item.clientName || item.appointmentId}</Text>
          <Text style={styles.cardMeta}>Appointment: {formatDateTime(item.appointmentStartTime)}</Text>
          <Text style={styles.cardMeta}>{item.summaryGeneratedAt ? new Date(item.summaryGeneratedAt).toLocaleString() : ''}</Text>
          <Text style={styles.summaryText}>{item.summary}</Text>
        </View>
      ))}
    </>
  );

  const renderOperationsTab = () => (
    <>
      {renderReadinessPanel()}
      {renderActiveDelegations()}
      {renderRecentSummaries()}
    </>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Agent Desk' }} />

      <View style={styles.stickyHeaderOuter}>
        <View style={styles.contentClamp}>
          <View style={styles.stickyHeader}>
            {renderContextHeader()}
            {renderTabSwitcher()}
          </View>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.contentClamp}>{activeTab === 'CHAT' ? renderChatTab() : renderOperationsTab()}</View>
      </ScrollView>

      <Modal visible={appointmentModalOpen} animationType="slide" transparent onRequestClose={() => setAppointmentModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Switch Appointment Context</Text>
            <ScrollView style={styles.modalList}>
              {filteredAppointments.length === 0 ? (
                <>
                  <Text style={styles.emptyText}>No visits for active filters.</Text>
                  <TouchableOpacity style={styles.modalCloseBtn} onPress={clearFilters}>
                    <Text style={styles.modalCloseText}>Clear filters</Text>
                  </TouchableOpacity>
                </>
              ) : null}
              {filteredAppointments.map((item) => {
                const selected = item.id === appointmentId;
                return (
                  <TouchableOpacity
                    key={`context-${item.id}`}
                    style={[styles.modalOption, selected && styles.modalOptionSelected]}
                    onPress={() => {
                      setAppointmentId(item.id);
                      setAppointmentModalOpen(false);
                    }}
                  >
                    <Text style={[styles.modalOptionText, selected && styles.modalOptionTextSelected]}>
                      {item.client_name} • {formatDateTime(item.start_time)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setAppointmentModalOpen(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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

      <Modal visible={chatExpanded} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setChatExpanded(false)}>
        <View style={styles.chatExpandedContainer}>
          <View style={styles.chatExpandedHeader}>
            <TouchableOpacity style={styles.chatBackBtn} onPress={() => setChatExpanded(false)}>
              <Text style={styles.chatBackBtnText}>Back</Text>
            </TouchableOpacity>
            <Text style={styles.chatExpandedTitle}>Caregiver Chat</Text>
            <TouchableOpacity style={styles.chatCollapseBtn} onPress={() => setChatExpanded(false)}>
              <Text style={styles.chatCollapseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.chatExpandedHint}>Fullscreen mode active. Use Back or Close anytime.</Text>
          {renderChatThread(expandedChatPanelHeight)}
          {renderChatComposer()}
          <TouchableOpacity style={styles.chatExitBtn} onPress={() => setChatExpanded(false)}>
            <Text style={styles.chatExitBtnText}>Exit Fullscreen</Text>
          </TouchableOpacity>
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
  contentClamp: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
  },
  stickyHeaderOuter: {
    paddingHorizontal: DS.spacing.md,
    paddingTop: DS.spacing.md,
    paddingBottom: DS.spacing.xs,
    backgroundColor: DS.colors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: DS.colors.border,
  },
  stickyHeader: {
    width: '100%',
    paddingHorizontal: 0,
  },
  scrollContent: {
    padding: DS.spacing.md,
    paddingBottom: DS.spacing.xl,
    alignItems: 'center',
  },
  contextHeader: {
    ...baseStyles.card,
    gap: DS.spacing.sm,
    marginBottom: DS.spacing.sm,
    padding: DS.spacing.md,
  },
  contextHeaderMainRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: DS.spacing.sm,
  },
  contextHeaderMainRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  contextHeaderTextWrap: {
    flex: 1,
  },
  contextHeaderLabel: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  contextHeaderTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
    marginTop: 2,
  },
  contextHeaderHint: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    marginTop: 2,
  },
  contextSwitchBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    backgroundColor: DS.colors.surface,
    minHeight: 44,
    justifyContent: 'center',
  },
  contextSwitchBtnStacked: {
    alignSelf: 'flex-start',
  },
  contextSwitchBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  contextFilterRow: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
    alignItems: 'stretch',
  },
  contextFilterRowStacked: {
    flexDirection: 'column',
  },
  contextFilterPill: {
    flex: 1,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    minHeight: 56,
    justifyContent: 'center',
  },
  contextFilterPillStacked: {
    flex: 0,
  },
  contextFilterLabel: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
  },
  contextFilterValue: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
    marginTop: 1,
  },
  contextFilterClear: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  contextFilterClearStacked: {
    width: '100%',
  },
  contextFilterClearText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  tabRow: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
    marginBottom: DS.spacing.sm,
  },
  tabBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    alignItems: 'center',
    paddingVertical: DS.spacing.xs,
  },
  tabBtnActive: {
    borderColor: DS.colors.brand,
    backgroundColor: '#DFF3EF',
  },
  tabBtnText: {
    color: DS.colors.textSecondary,
    fontWeight: '700',
    fontSize: DS.typography.caption,
  },
  tabBtnTextActive: {
    color: DS.colors.brandStrong,
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
  chatHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: DS.spacing.sm,
    marginBottom: DS.spacing.xs,
  },
  chatHeaderTextWrap: {
    flex: 1,
  },
  chatHeaderActions: {
    alignItems: 'flex-end',
    gap: DS.spacing.xs,
  },
  commandContextText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  chatSupportBtn: {
    borderWidth: 1,
    borderColor: '#BFD3F0',
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: '#EEF3FC',
    minHeight: 36,
    justifyContent: 'center',
  },
  chatSupportBtnText: {
    color: '#1E4F9A',
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  chatExpandBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
    minHeight: 36,
    justifyContent: 'center',
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
    backgroundColor: '#E9F6F3',
    borderWidth: 1,
    borderColor: '#C8E8E1',
    alignSelf: 'flex-end',
    maxWidth: '92%',
  },
  chatRowAgent: {
    backgroundColor: DS.colors.surface,
    borderWidth: 1,
    borderColor: DS.colors.border,
    alignSelf: 'flex-start',
    maxWidth: '96%',
  },
  chatRowMeta: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginBottom: 2,
    fontWeight: '700',
  },
  chatRowText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
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
  label: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xs,
    marginBottom: DS.spacing.xxs,
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
  readinessSummaryStrip: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
  },
  readinessMetric: {
    flex: 1,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: '#F7FBFA',
    padding: DS.spacing.xs,
  },
  readinessMetricLabel: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  readinessMetricValue: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
    marginTop: 2,
  },
  readinessMetricDanger: {
    color: DS.colors.danger,
  },
  readinessUpdated: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
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
  sectionHeader: {
    marginTop: DS.spacing.xs,
    marginBottom: DS.spacing.xs,
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
  },
  emptyText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    marginBottom: DS.spacing.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    padding: DS.spacing.sm,
    marginBottom: DS.spacing.sm,
  },
  cardTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    fontWeight: '800',
    marginBottom: DS.spacing.xxs,
  },
  cardMeta: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginBottom: 4,
  },
  summaryText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    lineHeight: 18,
    marginTop: DS.spacing.xs,
  },
  secondaryBtn: {
    marginTop: DS.spacing.sm,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: DS.colors.brand,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: '#E9F6F3',
  },
  secondaryBtnText: {
    color: DS.colors.brandStrong,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: DS.spacing.md,
  },
  modalCard: {
    ...baseStyles.card,
    maxHeight: '86%',
    padding: DS.spacing.md,
  },
  modalTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    marginBottom: DS.spacing.md,
  },
  modalList: {
    maxHeight: 320,
  },
  modalOption: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    backgroundColor: DS.colors.surface,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.sm,
    marginBottom: DS.spacing.sm,
  },
  modalOptionSelected: {
    borderColor: DS.colors.brand,
    backgroundColor: '#DFF3EF',
  },
  modalOptionText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  modalOptionTextSelected: {
    color: DS.colors.brandStrong,
  },
  modalCloseBtn: {
    marginTop: DS.spacing.sm,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    paddingVertical: DS.spacing.sm,
    alignItems: 'center',
    backgroundColor: DS.colors.surface,
  },
  modalCloseText: {
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
    width: 36,
    height: 36,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: DS.colors.surface,
  },
  calendarNavText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    fontWeight: '700',
  },
  calendarTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  weekHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: DS.spacing.xs,
  },
  weekLabel: {
    width: '14.2%',
    textAlign: 'center',
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    fontWeight: '700',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: DS.spacing.sm,
  },
  dayCell: {
    width: '14.2%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: DS.radius.sm,
    marginBottom: 4,
  },
  dayCellHasData: {
    backgroundColor: '#F4F9F8',
  },
  dayCellSelected: {
    backgroundColor: '#DFF3EF',
  },
  dayText: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  dayTextDisabled: {
    color: '#C2C7CF',
    fontWeight: '500',
  },
  dayTextSelected: {
    color: DS.colors.brandStrong,
  },
  modalActionRow: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
  },
  modalGhostBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: DS.spacing.sm,
  },
  modalGhostText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  chatExpandedContainer: {
    ...baseStyles.screen,
    paddingTop: DS.spacing.lg,
    paddingHorizontal: DS.spacing.md,
    paddingBottom: DS.spacing.md,
  },
  chatExpandedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DS.spacing.xs,
    gap: DS.spacing.xs,
  },
  chatBackBtn: {
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.pill,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 6,
    backgroundColor: DS.colors.surface,
  },
  chatBackBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  chatExpandedTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
    flex: 1,
    textAlign: 'center',
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
  chatExpandedHint: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginBottom: DS.spacing.sm,
  },
  chatExitBtn: {
    marginTop: DS.spacing.sm,
    borderWidth: 1,
    borderColor: DS.colors.border,
    borderRadius: DS.radius.sm,
    alignItems: 'center',
    paddingVertical: DS.spacing.sm,
    backgroundColor: DS.colors.surface,
  },
  chatExitBtnText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
});
