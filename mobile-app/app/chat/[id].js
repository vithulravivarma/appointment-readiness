import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import axios from 'axios';
import { API_BASE_URL } from '../../constants/Config';

export default function ChatScreen() {
  const { id } = useLocalSearchParams(); 
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    fetchHistory();
    // Poll for new messages every 3 seconds (Simple real-time simulation)
    const interval = setInterval(fetchHistory, 3000); 
    return () => clearInterval(interval);
  }, [id]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/appointments/${id}/messages`);
      setHistory(res.data.data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    
    // Optimistic UI: Show it immediately before server confirms
    const tempMsg = { 
        id: Date.now().toString(), 
        content: message, 
        sender_type: 'CAREGIVER' 
    };
    setHistory(prev => [...prev, tempMsg]);
    setMessage('');

    try {
      await axios.post(`${API_BASE_URL}/messages`, {
        appointmentId: id,
        content: tempMsg.content
      });
      fetchHistory(); // Sync real ID from server
    } catch (error) {
      Alert.alert('Error', 'Failed to send');
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
      style={styles.container}
    >
      <Stack.Screen options={{ title: 'Coordinator Chat' }} />

      <FlatList
        data={history}
        keyExtractor={item => item.id.toString()}
        contentContainerStyle={{ padding: 15 }}
        renderItem={({ item }) => (
          <View style={[
            styles.bubble, 
            item.sender_type === 'CAREGIVER' ? styles.myBubble : styles.theirBubble
          ]}>
            <Text style={[
            styles.bubbleText, 
            item.sender_type !== 'CAREGIVER' && { color: '#000' }
            ]}>
            {item.content}
            </Text>
            {item.sender_type !== 'CAREGIVER' && 
              <Text style={styles.senderLabel}>{item.sender_type}</Text>
            }
          </View>
        )}
      />

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder="Type update..."
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
  bubble: { padding: 10, borderRadius: 15, marginBottom: 10, maxWidth: '80%' },
  myBubble: { backgroundColor: '#007AFF', alignSelf: 'flex-end' },
  theirBubble: { backgroundColor: '#E5E5EA', alignSelf: 'flex-start' },
  bubbleText: { color: '#fff', fontSize: 16 }, // White text for blue bubble
  senderLabel: { fontSize: 10, color: '#666', marginTop: 4 },
  inputContainer: { flexDirection: 'row', padding: 15, backgroundColor: '#fff', alignItems: 'center' },
  input: { flex: 1, backgroundColor: '#f0f0f0', borderRadius: 20, padding: 10, marginRight: 10 },
  sendText: { color: '#007AFF', fontWeight: 'bold', fontSize: 16 }
});