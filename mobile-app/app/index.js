import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import axios from 'axios';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { DS, baseStyles } from '../design/system';
import { API_BASE_URL } from '../constants/Config';
import { SafeAreaView } from 'react-native-safe-area-context';

const ROLE_FILTERS = [
  { label: 'Caregivers', value: 'CAREGIVER' },
  { label: 'Patients', value: 'FAMILY' },
  { label: 'Schedulers', value: 'COORDINATOR' },
];

export default function LoginScreen() {
  const router = useRouter();
  const [accounts, setAccounts] = useState([]);
  const [roleFilter, setRoleFilter] = useState('CAREGIVER');
  const [selectedUsername, setSelectedUsername] = useState('');
  const [password, setPassword] = useState('demo123');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadAccounts();
  }, []);

  const filtered = useMemo(
    () => accounts.filter((item) => item.role === roleFilter),
    [accounts, roleFilter]
  );

  useEffect(() => {
    if (!filtered.length) {
      setSelectedUsername('');
      return;
    }

    if (!filtered.some((item) => item.username === selectedUsername)) {
      setSelectedUsername(filtered[0].username);
    }
  }, [filtered, selectedUsername]);

  const loadAccounts = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_BASE_URL}/auth/accounts`);
      const list = response.data?.data || [];
      setAccounts(list);
    } catch (e) {
      setError('Could not load ingested users. Run /ingest/excel first.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!selectedUsername || !password) {
      setError('Select an account and enter a password.');
      return;
    }

    try {
      setSubmitting(true);
      setError('');

      const response = await axios.post(`${API_BASE_URL}/auth/login`, {
        username: selectedUsername,
        password,
      });

      const { token, user } = response.data;
      const destination = user.role === 'COORDINATOR' ? '/scheduler-desk' : '/dashboard';

      router.push({
        pathname: destination,
        params: {
          userId: user.userId,
          name: user.name,
          role: user.role,
          authToken: token,
          username: user.username,
        },
      });
    } catch (e) {
      setError('Login failed. Verify password (default is demo123).');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenScheduler = async () => {
    try {
      setSubmitting(true);
      setError('');

      const response = await axios.post(`${API_BASE_URL}/auth/login`, {
        username: 'scheduler-local',
        password: 'demo123',
      });

      const { token, user } = response.data;
      router.push({
        pathname: '/scheduler-desk',
        params: {
          userId: user.userId,
          name: user.name,
          role: user.role,
          authToken: token,
          username: user.username,
        },
      });
    } catch (e) {
      setError('Could not open scheduler view. Ensure appointment-management-service is running.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <Text style={styles.kicker}>Appointment Readiness</Text>
            <Text style={styles.header}>Sign in to your workspace</Text>
            <Text style={styles.subHeader}>
              Accounts are auto-created from ingested appointments. Default password is demo123.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Role</Text>
            <View style={styles.roleRow}>
              {ROLE_FILTERS.map((entry) => {
                const active = roleFilter === entry.value;
                return (
                  <TouchableOpacity
                    key={entry.value}
                    onPress={() => setRoleFilter(entry.value)}
                    style={[styles.roleChip, active && styles.roleChipActive]}
                  >
                    <Text style={[styles.roleChipText, active && styles.roleChipTextActive]}>{entry.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sectionTitle}>Account</Text>
            {loading ? (
              <View style={styles.loaderWrap}>
                <ActivityIndicator size="small" color={DS.colors.brand} />
              </View>
            ) : (
              <View style={styles.accountList}>
                {filtered.map((account) => {
                  const active = selectedUsername === account.username;
                  return (
                    <TouchableOpacity
                      key={account.username}
                      style={[styles.accountRow, active && styles.accountRowActive]}
                      onPress={() => setSelectedUsername(account.username)}
                    >
                      <View style={styles.accountIdentity}>
                        <Text style={styles.accountName}>{account.name}</Text>
                        <Text style={styles.accountMeta}>{account.username}</Text>
                      </View>
                      {active && <Ionicons name="checkmark-circle" size={20} color={DS.colors.brand} />}
                    </TouchableOpacity>
                  );
                })}
                {!filtered.length && <Text style={styles.emptyText}>No accounts for this role yet.</Text>}
              </View>
            )}

            <Text style={styles.sectionTitle}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              secureTextEntry
              placeholder="Enter password"
              placeholderTextColor={DS.colors.textMuted}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.loginButton, submitting && styles.loginButtonDisabled]}
              onPress={handleLogin}
              disabled={submitting}
            >
              <Text style={styles.loginButtonText}>{submitting ? 'Signing in...' : 'Sign In'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.schedulerCard}
            onPress={handleOpenScheduler}
          >
            <Text style={styles.schedulerTitle}>Open Scheduler View</Text>
            <Text style={styles.schedulerText}>Local coordinator sign-in for scheduler escalation workflows.</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    ...baseStyles.screen,
  },
  container: {
    ...baseStyles.screen,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: DS.spacing.md,
    paddingTop: DS.spacing.xl,
    paddingBottom: DS.spacing.xl,
  },
  hero: {
    backgroundColor: DS.colors.brandStrong,
    borderRadius: DS.radius.lg,
    paddingHorizontal: DS.spacing.lg,
    paddingVertical: DS.spacing.lg,
    marginBottom: DS.spacing.md,
  },
  kicker: {
    color: '#B9E4DE',
    fontSize: DS.typography.caption,
    fontWeight: '700',
    marginBottom: DS.spacing.xs,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  header: {
    color: '#F3FFFC',
    fontSize: DS.typography.title,
    fontWeight: '800',
    marginBottom: DS.spacing.xs,
  },
  subHeader: {
    color: '#E0F2EE',
    fontSize: DS.typography.caption,
    lineHeight: 18,
  },
  card: {
    ...baseStyles.card,
    padding: DS.spacing.md,
  },
  sectionTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
    marginBottom: DS.spacing.xs,
    marginTop: DS.spacing.sm,
  },
  roleRow: {
    flexDirection: 'row',
    gap: DS.spacing.xs,
  },
  roleChip: {
    borderRadius: DS.radius.pill,
    borderWidth: 1,
    borderColor: DS.colors.border,
    paddingVertical: 8,
    paddingHorizontal: DS.spacing.sm,
    backgroundColor: DS.colors.surface,
  },
  roleChipActive: {
    backgroundColor: '#DFF3EF',
    borderColor: '#B3DCD5',
  },
  roleChipText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.caption,
    fontWeight: '700',
  },
  roleChipTextActive: {
    color: DS.colors.brandStrong,
  },
  accountList: {
    borderRadius: DS.radius.md,
    borderWidth: 1,
    borderColor: DS.colors.border,
    backgroundColor: DS.colors.surfaceMuted,
    padding: DS.spacing.xs,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: DS.radius.sm,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: DS.spacing.sm,
  },
  accountRowActive: {
    backgroundColor: DS.colors.surface,
    borderWidth: 1,
    borderColor: '#B3DCD5',
  },
  accountIdentity: {
    flex: 1,
    paddingRight: DS.spacing.xs,
  },
  accountName: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.body,
    fontWeight: '700',
  },
  accountMeta: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.micro,
    marginTop: 2,
  },
  emptyText: {
    color: DS.colors.textMuted,
    fontSize: DS.typography.caption,
    padding: DS.spacing.sm,
  },
  input: {
    backgroundColor: DS.colors.surface,
    borderRadius: DS.radius.sm,
    borderWidth: 1,
    borderColor: DS.colors.border,
    color: DS.colors.textPrimary,
    paddingHorizontal: DS.spacing.sm,
    paddingVertical: 10,
    fontSize: DS.typography.body,
  },
  error: {
    color: DS.colors.danger,
    marginTop: DS.spacing.xs,
    fontSize: DS.typography.caption,
  },
  loaderWrap: {
    paddingVertical: DS.spacing.sm,
  },
  loginButton: {
    marginTop: DS.spacing.md,
    borderRadius: DS.radius.pill,
    backgroundColor: DS.colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  loginButtonDisabled: {
    opacity: 0.7,
  },
  loginButtonText: {
    color: DS.colors.surface,
    fontWeight: '800',
    fontSize: DS.typography.body,
  },
  schedulerCard: {
    ...baseStyles.card,
    marginTop: DS.spacing.md,
    padding: DS.spacing.md,
    backgroundColor: '#FAEFE1',
    borderColor: '#E6C8A0',
  },
  schedulerTitle: {
    color: DS.colors.textPrimary,
    fontSize: DS.typography.caption,
    fontWeight: '800',
  },
  schedulerText: {
    color: DS.colors.textSecondary,
    fontSize: DS.typography.micro,
    marginTop: DS.spacing.xxs,
    lineHeight: 15,
  },
});
