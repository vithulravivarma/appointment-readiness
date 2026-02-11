import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { useRouter } from 'expo-router'; // Use useRouter instead of Link for conditional logic
import { Ionicons } from '@expo/vector-icons';

const API_URL = `${API_BASE_URL}/appointments`;

export default function AppointmentList({ role, userId }) {
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter(); 

    useEffect(() => {
        fetchAppointments();
    }, []);

    const fetchAppointments = async () => {
        try {
            const params = { 
                userId: userId, 
                role: role 
            }; 
            
            console.log("Fetching with params:", params);

            const response = await axios.get(API_URL, { params });
            const list = Array.isArray(response.data) ? response.data : response.data.data;
            
            setAppointments(list || []);

        } catch (error) {
            console.error("Fetch failed:", error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return (
        <View style={[styles.container, styles.center]}>
            <ActivityIndicator size="large" color="#007AFF" />
        </View>
    );

    // Helper: Is this a "Chat User" (Caregiver/Family) or the "Boss" (Coordinator)?
    const isChatUser = role === 'CAREGIVER' || role === 'FAMILY';

    return (
        <ScrollView style={styles.container}>
            {appointments.map((item) => (
                <TouchableOpacity 
                    key={item.id} 
                    style={styles.card}
                    onPress={() => {
                        // --- THE NEW LOGIC ---
                        if (isChatUser) {
                            // 1. Caregivers/Patients go STRAIGHT TO CHAT
                            router.push({
                                pathname: `/chat/${item.id}`,
                                params: { role, userId } // Pass identity!
                            });
                        } else {
                            // 2. Schedulers go to READINESS DETAILS
                            router.push({
                                pathname: `/appointment/${item.id}`,
                                params: { role, userId }
                            });
                        }
                    }}
                >
                    <View style={styles.cardHeader}>
                        <View>
                            <Text style={styles.title}>{item.client_name}</Text>
                            <Text style={styles.subtitle}>{item.service_type}</Text>
                        </View>
                        
                        <View style={[
                            styles.iconBadge, 
                            isChatUser ? { backgroundColor: '#E3F2FD' } : { backgroundColor: '#FFF3E0' }
                        ]}>
                            <Ionicons 
                                name={isChatUser ? "chatbubble-ellipses" : "clipboard"} 
                                size={24} 
                                color={isChatUser ? "#2196F3" : "#FF9800"} 
                            />
                        </View>
                    </View>

                    <View style={styles.cardFooter}>
                        {isChatUser ? (
                            <View style={styles.chatRow}>
                                <Text style={{ color: '#2196F3', fontWeight: 'bold' }}>
                                    Tap to Chat &rarr;
                                </Text>
                            </View>
                        ) : (
                            <Text style={[
                                styles.status,
                                item.readiness_status === 'READY' ? styles.ready : styles.risk
                            ]}>
                                Status: {item.readiness_status}
                            </Text>
                        )}
                    </View>
                </TouchableOpacity>
            ))}
            <View style={{ height: 40 }} />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { 
        flex: 1, 
        padding: 20, 
        backgroundColor: '#f5f5f5' // Light Grey Background
    }, 
    center: { justifyContent: 'center', alignItems: 'center' },
    card: {
        backgroundColor: '#fff',
        padding: 20,
        marginBottom: 15,
        borderRadius: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    title: { fontSize: 18, fontWeight: 'bold', color: '#333' },
    subtitle: { fontSize: 14, color: '#666', marginTop: 4 },
    iconBadge: {
        width: 44, height: 44, borderRadius: 22,
        justifyContent: 'center', alignItems: 'center'
    },
    cardFooter: {
        marginTop: 15,
        paddingTop: 15,
        borderTopWidth: 1,
        borderTopColor: '#f0f0f0'
    },
    chatRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center'
    },
    status: { fontWeight: 'bold', fontSize: 14 },
    ready: { color: 'green' },
    risk: { color: 'red' }
});