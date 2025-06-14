const { default: axios } = require("axios");
const redisClient = require("../config/redis");
const { getSocket } = require("./websocket/driver");
const { Driver } = require("../models/index");
const { getInfoBasedOnRoadRoute, getPolyline } = require("./map.service");
const { sendNotification } = require("./notification.service");
const logger = require("../config/logger");

const HERE_API_KEY = process.env.HERE_API_KEY;

const FIND_DRIVER_TIMEOUT_SECS = 300;
const FIND_DRIVER_INTERVAL_SECS = 3;

const searchSessions = new Map(); // { sessionId: { socket, vehicleType, pickupLat, pickupLng, data, orderId, interval, resolve, reject } }

const scanForDriver = (vehicleType, pickupLat, pickupLng, data, orderId) => {
    return new Promise((resolve, reject) => {
        const sessionId = orderId
        let interval;

        const scan = async () => {
            try {
                const match = await matchDriver(vehicleType, { pickupLat, pickupLng }, data, orderId);
                if (match) {
                    clearInterval(interval);
                    searchSessions.delete(sessionId);
                    resolve(match);
                }
            } catch (error) {
                logger.error('Scan error:', error);
            }
        };
        // Quét ban đầu
        scan();

        // Quét định kỳ mỗi 3 giây
        interval = setInterval(scan, FIND_DRIVER_INTERVAL_SECS * 1000);

        // Lưu session
        searchSessions.set(sessionId, {
            interval,
            reject,
        });

        // Dừng sau timeout
        setTimeout(() => {
            if (searchSessions.has(sessionId)) {
                clearInterval(interval);
                searchSessions.delete(sessionId);
                reject(new Error('No driver found within timeout'));
            }
        }, FIND_DRIVER_TIMEOUT_SECS * 1000);
    })
}


const getAvailableNearestDrivers = async (transportType, orderPickUpLocation) => {
    const { pickupLat: lat, pickupLng: lng } = orderPickUpLocation;

    // const driverKeys = await redisClient.zrange('drivers:locations', 0, -1); // lấy tất cả driver IDs
    const driverKeys = await redisClient.call(
        'GEOSEARCH',
        'drivers:locations',
        'FROMLONLAT',
        lng,
        lat,
        'BYRADIUS',
        10,
        'km'
    );

    console.log('driverKeys', driverKeys)


    const driverLocations = await Promise.all(
        driverKeys.map(id => redisClient.geopos('drivers:locations', id))
    );


    const drivers = driverKeys.map((id, index) => ({
        id,
        duration: driverLocations[index][0] ? getInfoBasedOnRoadRoute(transportType,
            { lng: driverLocations[index][0][0], lat: driverLocations[index][0][1] }, { lat, lng }).duration : null,
        lng: parseFloat(driverLocations[index][0][0]),
        lat: parseFloat(driverLocations[index][0][1])
    }));

    drivers.sort((a, b) => a.duration - b.duration);

    return drivers; // [{id, lng, lat}]
}

const getOrderDetail = async (orderData, driverPos) => {
    const { orderMain,
        orderSenderReceiver,
        orderLocation, orderDetail,
        orderSpecialDemand } = orderData;

    const pickupDropoffSummary = await getInfoBasedOnRoadRoute(orderMain.vehicleType,
        { lat: orderLocation.pickupLat, lng: orderLocation.pickupLng },
        { lat: orderLocation.dropoffLat, lng: orderLocation.dropoffLng });
    const pickupDropoffDistance = pickupDropoffSummary.length;

    const driverPickupSummary = await getInfoBasedOnRoadRoute(orderMain.vehicleType,
        { lat: driverPos.lat, lng: driverPos.lng },
        { lat: orderLocation.pickupLat, lng: orderLocation.pickupLng });
    const driverPickupDistance = driverPickupSummary.length;

    console.log('driverPos', driverPos)
    const driverPickupPolyline = await getPolyline(orderMain.vehicleType,
        { lat: driverPos.lat, lng: driverPos.lng },
        { lat: orderLocation.pickupLat, lng: orderLocation.pickupLng });

    const pickupDropoffPolyline = await getPolyline(orderMain.vehicleType,
        { lat: orderLocation.pickupLat, lng: orderLocation.pickupLng },
        { lat: orderLocation.dropoffLat, lng: orderLocation.dropoffLng });

    return {
        orderMain,
        orderLocation,
        orderDetail,
        orderSenderReceiver: {
            sender: {
                name: orderSenderReceiver.senderName,
                phoneNumber: orderSenderReceiver.senderPhoneNumber,
            },
            receiver: {
                name: orderSenderReceiver.receiverName,
                phoneNumber: orderSenderReceiver.receiverPhoneNumber
            }
        },
        orderSpecialDemand,
        pickupDropoffDistance,
        driverPickupDistance,
        driverPickupPolyline,
        pickupDropoffPolyline
    }
}


const matchDriver = async (transportType, orderPickUpLocation, orderData, orderId) => {
    let driverPickupPolyline = null
    let pickupDropoffPolyline = null
    let resDriver = null;
    const drivers = await getAvailableNearestDrivers(transportType, orderPickUpLocation)
    for (const driver of drivers) {
        const exist = await Driver.findByPk(driver.id);
        if (!exist) continue;
        const { status, autoAccept } = exist;
        if (status !== 'AVAILABLE') continue
        const socket = getSocket(driver.id);
        if (!socket) continue;

        const orderDetail = await getOrderDetail(orderData, driver);

        await redisClient.set(`driver:${driver.id}:available`, JSON.stringify({ orderId, ...orderDetail }), 'EX', 30);
        sendNotification(driver.id, 'Có đơn hàng mới', `Đơn vận chuyển mới: ${orderDetail.orderDetail.packageType}`);
        if (autoAccept) {
            resDriver = driver;
            pickupDropoffPolyline = orderDetail.pickupDropoffPolyline;
            driverPickupPolyline = orderDetail.driverPickupPolyline;
            const driverInstance = await Driver.findByPk(driver.id);
            if (driverInstance) {
                await driverInstance.update({ status: 'BUSY' });
                console.log(`Driver ${driver.id} went busy.`);
            }
            socket.emit('order:available', {
                success: true,
                data: { orderId, ...orderDetail }
            });
            break;
        }
        socket.emit('order:new', {
            success: true,
            message: 'Order request',
            data: orderDetail
        });

        const response = await waitForDriverResponse(socket);
        if (response?.accepted) {
            resDriver = driver;
            pickupDropoffPolyline = orderDetail.pickupDropoffPolyline;
            driverPickupPolyline = orderDetail.driverPickupPolyline;
            setImmediate(async () => {
                const driverInstance = await Driver.findByPk(driver.id);
                if (driverInstance) {
                    await driverInstance.update({ status: 'BUSY' });
                    console.log(`Driver ${driver.id} went busy.`);
                }
            });

            break;
        }

    }
    console.log('3', resDriver)
    if (!resDriver || !pickupDropoffPolyline || !driverPickupPolyline) return null;
    return { resDriver, pickupDropoffPolyline, driverPickupPolyline };
}

const waitForDriverResponse = async (socket) => {
    return await new Promise((resolve) => {
        const onResponse = (data) => {
            clearTimeout(timeout);
            resolve(data);
        };

        const timeout = setTimeout(() => {
            socket.off('order:reply', onResponse);
            resolve(null);
        }, 30000);

        socket.once('order:reply', onResponse);
    });
}

const driverDirectionSupport = async (transportType, driverLocation, orderLocation) => {
    return await directRoute(transportType, driverLocation, orderLocation);
}

const directRoute = async (transportType, origin, destination) => {
    try {
        const transportMode = transportType === 'MOTORBIKE' ? 'scooter' : 'car'

        const res = await axios.get(`https://router.hereapi.com/v8/routes?transportMode=${transportMode}&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&return=summary,polyline,actions,instructions&lang=vi&apikey=${HERE_API_KEY}`);

        const section = res.data.routes[0].sections[0];
        const actions = section.actions;
        const polyline = section.polyline;

        return {
            actions,
            polyline
        };
    } catch (error) {
        console.error('Error getting route direction:', error);
        return null;
    }
}


module.exports = { scanForDriver, driverDirectionSupport, matchDriver };
