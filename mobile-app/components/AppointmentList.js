import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
} from 'react-native';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { DS, baseStyles } from '../design/system';

const API_URL = `${API_BASE_URL}/appointments`;

export default function AppointmentList({ role, userId, authToken }) {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  const [clientFilter, setClientFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const router = useRouter();

  useEffect(() => {
    fetchAppointments();
  }, []);

  const sortedAppointments = useMemo(() => {
    return [...appointments].sort((a, b) => {
      const left = new Date(a.start_time || '').getTime();
      const right = new Date(b.start_time || '').getTime();
      return right - left;
    });
  }, [appointments]);

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

  const fetchAppointments = async () => {
    try {
      setLoading(true);
      const response = await axios.get(API_URL, {
        params: {
          userId,
          role,
        },
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      const list = Array.isArray(response.data) ? response.data : response.data.data;
      setAppointments(list || []);
    } catch (error) {
      console.error('Fetch failed:', error);
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  };

  const clearFilters = () => {
    setClientFilter('');
    setDateFilter('');
  };

  if (loading) {
    return (
      <View style={styles.loaderWrap}>
        <ActivityIndicator size="large" color={DS.colors.brand} />
      </View>
    );
  }

  const isChatUser = role === 'CAREGIVER' || role === 'FAMILY';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.contentContainer}>
        <Text style={styles.pageTitle}>{isChatUser ? 'Your Conversations' : 'Operations Board'}</Text>
        <Text style={styles.pageSubtitle}>Sorted by most recent visit first for quick scanning.</Text>

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

        {filteredAppointments.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={styles.card}
            onPress={() => {
              if (isChatUser) {
                router.push({
                  pathname: `/chat/${item.id}`,
                  params: { role, userId, authToken },
                });
                return;
              }

              router.push({
                pathname: `/appointment/${item.id}`,
                params: { role, userId, authToken },
              });
            }}
          >
            <View style={styles.cardHeader}>
              <View style={styles.headlineWrap}>
                <Text style={styles.title}>{item.client_name}</Text>
                <Text style={styles.subtitle}>{item.service_type || 'Home Health Visit'}</Text>
                <Text style={styles.metaText}>{formatApptDateTime(item.start_time)}</Text>
              </View>

              <View style={[styles.iconBadge, isChatUser ? styles.chatBadge : styles.opsBadge]}>
                <Ionicons
                  name={isChatUser ? 'chatbubble-ellipses' : 'clipboard'}
                  size={20}
                  color={isChatUser ? DS.colors.info : DS.colors.accent}
                />
              </View>
            </View>

            <View style={styles.cardFooter}>
              <Text style={styles.datePill}>{formatDateOnly(item.start_time)}</Text>
              {isChatUser ? (
                <Text style={styles.cta}>Open thread</Text>
              ) : (
                <Text
                  style={[
                    styles.status,
                    item.readiness_status === 'READY' ? styles.ready : styles.atRisk,
                  ]}
                >
                  {item.readiness_status}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        ))}

        {filteredAppointments.length === 0 ? <Text style={styles.empty}>No conversations for these filters.</Text> : null}
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
    </View>
  );
}

function toIsoDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return formatIsoDate(date);
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
}

function formatApptDateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }

  return `${date.toLocaleDateString()} • ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function formatDateOnly(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return date.toLocaleDateString();
}

function addMonths(date, offset) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function formatMonthLabel(date) {
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function buildCalendarCells(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < first.getDay(); i += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, month, day));
  }

  return cells;
}

const styles = StyleSheet.create({
  container: {
    ...baseStyles.screen,
  },
  contentContainer: {
    paddingHorizontal: DS.spacing.md,
    paddingBottom: DS.spacing.xl,
  },
  loaderWrap: {
    ...baseStyles.screen,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.title,
    fontWeight: '800',
    marginTop: DS.spacing.sm,
  },
  pageSubtitle: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xxs,
    marginBottom: DS.spacing.md,
  },
  filterBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  card: {
    ...baseStyles.card,
    padding: DS.spacing.md,
    marginBottom: DS.spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headlineWrap: {
    flex: 1,
    paddingRight: DS.spacing.sm,
  },
  title: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.subtitle,
    fontWeight: '800',
  },
  subtitle: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.xxs,
  },
  metaText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: DS.spacing.xxs,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: DS.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBadge: {
    backgroundColor: '#E8EFFC',
  },
  opsBadge: {
    backgroundColor: '#FAEFE1',
  },
  cardFooter: {
    marginTop: DS.spacing.md,
    paddingTop: DS.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: DS.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  datePill: {
    color: DS.colors.brandStrong,
    backgroundColor: '#DFF3EF',
    fontSize: DS.typography.micro,
    fontWeight: '700',
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
    overflow: 'hidden',
  },
  cta: {
    color: DS.colors.info,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  status: {
    alignSelf: 'flex-start',
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 5,
    borderRadius: DS.radius.pill,
    fontSize: DS.typography.caption,
    fontWeight: '700',
    overflow: 'hidden',
  },
  ready: {
    color: DS.colors.success,
    backgroundColor: '#E7F5EC',
  },
  atRisk: {
    color: DS.colors.warning,
    backgroundColor: '#FBF0DF',
  },
  empty: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    marginTop: DS.spacing.sm,
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
