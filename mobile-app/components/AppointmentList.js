import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import axios from 'axios';
import { API_BASE_URL } from '../constants/Config';
import { Link } from 'expo-router';

const API_URL = `${API_BASE_URL}/appointments`;

export default function AppointmentList() {
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchAppointments();
    }, []);

    const fetchAppointments = async () => {
        try {
            const response = await axios.get(API_URL);
            setAppointments(response.data.data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return <Text style={styles.text}>Loading...</Text>;
    }

    return (
        <ScrollView style={styles.container}>
            {appointments.map((item) => (
                <Link key={item.id} href={`/appointment/${item.id}`} asChild>
                    <TouchableOpacity>
                        <View style={styles.card}>
                            <Text style={styles.title}>{item.client_name}</Text>
                            <Text style={styles.subtitle}>{item.service_type}</Text>
                            <Text style={[
                                styles.status,
                                item.readiness_status === 'READY' ? styles.ready : styles.risk
                            ]}>
                                Status: {item.readiness_status}
                            </Text>
                        </View>
                    </TouchableOpacity>
                </Link>
            ))}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, padding: 20 },
    text: { fontSize: 18, padding: 20 },
    card: {
        backgroundColor: '#fff',
        padding: 15,
        marginBottom: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#ddd'
    },
    title: { fontSize: 18, fontWeight: 'bold' },
    subtitle: { fontSize: 14, color: '#666', marginBottom: 5 },
    status: { fontWeight: 'bold', marginTop: 5 },
    ready: { color: 'green' },
    risk: { color: 'red' }
});