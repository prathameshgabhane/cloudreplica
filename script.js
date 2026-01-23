function compare() {

    // Read user input
    let region = document.getElementById("region").value;
    let os = document.getElementById("os").value;
    let cpu = document.getElementById("cpu").value;
    let ram = document.getElementById("ram").value;

    // Temporary mock response (later this comes from Azure Function)
    let data = {
        aws: {
            instance: "t3.medium",
            vcpu: cpu,
            ram: ram,
            price: "0.0464 USD"
        },
        azure: {
            instance: "Standard_B2ms",
            vcpu: cpu,
            ram: ram,
            price: "0.052 USD"
        }
    };

    // Display AWS
    document.getElementById("awsInstance").innerText = "Instance: " + data.aws.instance;
    document.getElementById("awsCpu").innerText = "vCPU: " + data.aws.vcpu;
    document.getElementById("awsRam").innerText = "RAM: " + data.aws.ram + " GB";
    document.getElementById("awsPrice").innerText = "Price/hr: " + data.aws.price;

    // Display Azure
    document.getElementById("azInstance").innerText = "VM Size: " + data.azure.instance;
    document.getElementById("azCpu").innerText = "vCPU: " + data.azure.vcpu;
    document.getElementById("azRam").innerText = "RAM: " + data.azure.ram + " GB";
    document.getElementById("azPrice").innerText = "Price/hr: " + data.azure.price;
}
