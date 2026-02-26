import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import axios from 'axios';
import { API_BASE_URL } from '../../constants/Config';
import { DS, baseStyles } from '../../design/system';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ChatScreen() {
  const { id, role, userId, authToken } = useLocalSearchParams();
  const currentRole = role || 'CAREGIVER';
  const currentUserId = userId || 'demo-user';
  const router = useRouter();

  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);
  const flatListRef = useRef(null);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 3000);
    return () => clearInterval(interval);
  }, [id]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/appointments/${id}/messages`, {
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
        appointmentId: id,
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        style={styles.container}
      >
        <Stack.Screen options={{ title: `Chat (${currentRole})` }} />

        {currentRole === 'CAREGIVER' && (
          <View style={styles.agentBar}>
            <View style={{ flex: 1, paddingRight: DS.spacing.sm }}>
              <Text style={styles.agentTitle}>Agent is managed from Agent Desk</Text>
              <Text style={styles.agentSubtitle}>
                Use free-form commands there or start structured delegations, then return for summaries.
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
});
