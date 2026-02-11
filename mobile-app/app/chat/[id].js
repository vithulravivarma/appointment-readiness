import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, Alert, Switch } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import axios from 'axios';
import { API_BASE_URL } from '../../constants/Config';

export default function ChatScreen() {
  // 1. GET USER CONTEXT (Passed from Dashboard/AppointmentList)
  // Default to 'CAREGIVER' if testing directly without the flow
  const { id, role, userId } = useLocalSearchParams(); 
  const currentRole = role || 'CAREGIVER'; 
  const currentUserId = userId || 'demo-user';

  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);
  const flatListRef = useRef(null);

  // New State for the Toggle
  const [agentStatus, setAgentStatus] = useState('ACTIVE');

  // Fetch agent status on load
  useEffect(() => {
    fetchHistory();
    fetchAgentStatus(); // <-- Add this
    const interval = setInterval(fetchHistory, 3000); 
    return () => clearInterval(interval);
  }, [id]);

  const fetchAgentStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${currentUserId}/status`);
      setAgentStatus(res.data.status);
    } catch (e) {
      console.log("No agent status found, defaulting to ACTIVE");
    }
  };

  const toggleAgent = async () => {
    const newStatus = agentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    // Optimistic UI update
    setAgentStatus(newStatus); 
    try {
      await axios.put(`${API_BASE_URL}/agents/${currentUserId}/status`, { status: newStatus });
    } catch (error) {
      console.error("Failed to toggle agent", error);
      Alert.alert('Error', 'Could not update Digital Twin status.');
      setAgentStatus(agentStatus); // Revert on failure
    }
  };

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 3000); 
    return () => clearInterval(interval);
  }, [id]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/appointments/${id}/messages`);
      setHistory(res.data.data);
    } catch (e) {
      console.error("Fetch Error:", e);
    }
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    
    // 2. OPTIMISTIC UI UPDATE
    // We use 'currentRole' so it appears on the right side immediately
    const tempMsg = { 
        id: Date.now().toString(), 
        content: message, 
        sender_type: currentRole, 
        created_at: new Date().toISOString()
    };
    
    setHistory(prev => [...prev, tempMsg]);
    setMessage('');
    
    // Scroll to bottom
    setTimeout(() => flatListRef.current?.scrollToEnd(), 100);

    try {
      // 3. SEND DYNAMIC IDENTITY TO SERVER
      await axios.post(`${API_BASE_URL}/messages`, {
        appointmentId: id,
        content: tempMsg.content,
        senderType: currentRole,  // <--- CRITICAL CHANGE
        senderId: currentUserId   // <--- CRITICAL CHANGE
      });
      
      // Refresh to get the real ID/Timestamp from server
      fetchHistory(); 
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Failed to send message');
    }
  };

  // Helper to decide bubble style
  const isMe = (msgSenderType) => msgSenderType === currentRole;

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
      style={styles.container}
    >
      {/* Dynamic Header Title */}
      <Stack.Screen options={{ title: `Chat (${currentRole})` }} />
      {/* 🤖 DIGITAL TWIN STATUS BAR */}
      {currentRole !== 'COORDINATOR' && (
        <View style={styles.agentBar}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 20, marginRight: 8 }}>🤖</Text>
            <View>
              <Text style={styles.agentTitle}>Digital Twin</Text>
              <Text style={[styles.agentSubtitle, { color: agentStatus === 'ACTIVE' ? '#34C759' : '#FF3B30' }]}>
                {agentStatus === 'ACTIVE' ? 'Auto-replying' : 'Paused'}
              </Text>
            </View>
          </View>
          <Switch 
            value={agentStatus === 'ACTIVE'} 
            onValueChange={toggleAgent}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
          />
        </View>
      )}


      <FlatList
        ref={flatListRef}
        data={history}
        keyExtractor={item => item.id.toString()}
        contentContainerStyle={{ padding: 15, paddingBottom: 20 }}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
        renderItem={({ item }) => {
          const amIMe = isMe(item.sender_type);
          const isAI = item.sender_type === 'AI_AGENT';

          return (
            <View style={[
              styles.bubble, 
              amIMe ? styles.myBubble : styles.theirBubble,
              isAI ? { backgroundColor: '#F3E5F5', borderColor: '#CE93D8', borderWidth: 1 } : null // Give AI a light purple look
            ]}>
              <Text style={[
                styles.bubbleText, 
                !amIMe && { color: '#000' },
                isAI && { color: '#4A148C', fontStyle: 'italic' } // Purple italic text for AI
              ]}>
                {item.content}
              </Text>
              
              {!amIMe && 
                <Text style={styles.senderLabel}>
                  {isAI ? '🤖 Digital Twin' : item.sender_type}
                </Text>
              }
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
          placeholderTextColor="#999"
        />
        <TouchableOpacity onPress={handleSend}>
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  bubble: { padding: 12, borderRadius: 16, marginBottom: 10, maxWidth: '80%' },
  agentBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    elevation: 2,
    zIndex: 10,
  },
  agentTitle: { fontWeight: 'bold', fontSize: 14, color: '#333' },
  agentSubtitle: { fontSize: 12, marginTop: 2 },
  
  // Blue bubble on right
  myBubble: { backgroundColor: '#007AFF', alignSelf: 'flex-end', borderBottomRightRadius: 2 },
  
  // Grey bubble on left
  theirBubble: { backgroundColor: '#E5E5EA', alignSelf: 'flex-start', borderBottomLeftRadius: 2 },
  
  bubbleText: { color: '#fff', fontSize: 16 },
  senderLabel: { fontSize: 10, color: '#666', marginTop: 4, textTransform: 'capitalize' },
  
  inputContainer: { 
    flexDirection: 'row', 
    padding: 15, 
    backgroundColor: '#fff', 
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#eee'
  },
  input: { 
    flex: 1, 
    backgroundColor: '#f0f0f0', 
    borderRadius: 20, 
    paddingHorizontal: 15, 
    paddingVertical: 10, 
    marginRight: 10,
    fontSize: 16
  },
  sendText: { color: '#007AFF', fontWeight: 'bold', fontSize: 16 }
});